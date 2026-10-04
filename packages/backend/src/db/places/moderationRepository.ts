/**
 * Every write moderation makes, and the reports that feed it.
 *
 * Each operator decision here runs in ONE transaction with the revision that
 * records it (`revisions.ts`), and locks the rows it decides on before reading
 * them, so two operators acting on the same claim, candidate or report at once
 * are serialized: the second sees the first's decision and is refused with
 * `conflict` rather than deciding a state that no longer exists.
 *
 * Reporting a place is the one public write in this module. It changes no
 * place — an operator decides — and so records no revision of its own;
 * resolving the report does.
 */

import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type {
  ClaimDecisionState,
  DuplicateCandidate,
  DuplicateCandidateReason,
  DuplicateCandidateState,
  DuplicateResolutionInput,
  ModerationPlaceReport,
  ModeratedPlaceStatus,
  PlaceClaim,
  PlaceClaimState,
  PlaceReport,
  PlaceReportInput,
  PlaceReportReason,
  PlaceReportResolution,
  PlaceReportState,
  PlaceRevisionChange,
  PlaceStatus,
  PlaceVerificationState,
  RevisionValue,
} from '@goway/contracts';
import { CLAIM_DECISION_FROM } from '@goway/contracts';
import { ApiError } from '../../http/apiError';
import type { Paged, TimeWindow } from '../../http/cursor';
import { assertPublished, unpublishedPlace } from '../../places/placeLifecycle';
import type { Database, DatabaseOrTransaction } from '../postgres';
import {
  placeReports,
  places,
  placesCapabilities,
  placesClaims,
  placesDuplicateCandidates,
  placesNames,
  placesSources,
} from '../schema';
import { CAPABILITY_COLUMNS, CLAIM_COLUMNS, toClaim } from './placeMapper';
import {
  claimField,
  deleteCapabilityAtTier,
  type CapabilityKeyParts,
  type PlaceLifecycle,
} from './placesRepository';
import {
  capabilityField,
  capabilitySnapshot,
  changeOf,
  nameField,
  recordRevision,
  type RevisionAuthor,
} from './revisions';

/** The person a decision is attributed to on the row it decides: the operator, else the session's account. */
function deciderOf(author: RevisionAuthor): string {
  return author.operatedByOxyUserId ?? author.oxyAccountId;
}

/** Lock one place and read its lifecycle, inside a moderation transaction. */
async function lockPlace(tx: DatabaseOrTransaction, placeId: string) {
  const [row] = await tx
    .select({
      id: places.id,
      status: places.status,
      mergedIntoPlaceId: places.mergedIntoPlaceId,
      verificationState: places.verificationState,
      verifiedAt: places.verifiedAt,
    })
    .from(places)
    .where(eq(places.id, placeId))
    .for('update');
  return row ? { ...row, status: row.status as PlaceStatus } : null;
}

function lifecycleOf(row: { status: PlaceStatus; mergedIntoPlaceId: string | null }): PlaceLifecycle {
  return { status: row.status, mergedIntoPlaceId: row.mergedIntoPlaceId };
}

/** A `(createdAt, id)` keyset over a queue, oldest first. */
function createdWindow(createdAt: PgColumn, id: PgColumn, window: TimeWindow): SQL | undefined {
  return window.after ? sql`(${createdAt}, ${id}) > (${window.after[0]}::timestamptz, ${window.after[1]})` : undefined;
}

// ── Reports ─────────────────────────────────────────────────────────────────

const REPORT_COLUMNS = {
  id: placeReports.id,
  placeId: placeReports.placeId,
  reason: placeReports.reason,
  note: placeReports.note,
  createdAt: placeReports.createdAt,
  resolution: placeReports.resolution,
  resolvedAt: placeReports.resolvedAt,
  position: sql<string>`${placeReports.createdAt}::text`,
} as const;

type ReportRow = {
  id: string;
  placeId: string;
  reason: string;
  note: string | null;
  createdAt: Date;
  resolution: string | null;
  resolvedAt: Date | null;
};

function toPlaceReport(row: ReportRow): PlaceReport {
  return {
    id: row.id,
    placeId: row.placeId,
    reason: row.reason as PlaceReportReason,
    createdAt: row.createdAt.toISOString(),
  };
}

function toModerationReport(row: ReportRow): ModerationPlaceReport {
  const report: ModerationPlaceReport = toPlaceReport(row);
  if (row.note !== null) report.note = row.note;
  if (row.resolution !== null) report.resolution = row.resolution as PlaceReportResolution;
  if (row.resolvedAt !== null) report.resolvedAt = row.resolvedAt.toISOString();
  return report;
}

/**
 * File a report, or answer the reporter's existing OPEN one on the same place.
 *
 * One open report per reporter per place is a unique index, so a repeat is
 * `on conflict do nothing` followed by a read of the row that won — no failed
 * statement, nothing for a retry to duplicate. A report that was resolved does
 * not block a new one: the place may have gone wrong again.
 */
export async function createPlaceReport(
  db: DatabaseOrTransaction,
  placeId: string,
  reporterOxyUserId: string,
  input: PlaceReportInput,
): Promise<{ report: PlaceReport; created: boolean }> {
  const [inserted] = await db
    .insert(placeReports)
    .values({ placeId, reporterOxyUserId, reason: input.reason, note: input.note ?? null })
    .onConflictDoNothing()
    .returning(REPORT_COLUMNS);
  if (inserted) return { report: toPlaceReport(inserted), created: true };

  const [existing] = await db
    .select(REPORT_COLUMNS)
    .from(placeReports)
    .where(
      and(
        eq(placeReports.placeId, placeId),
        eq(placeReports.reporterOxyUserId, reporterOxyUserId),
        isNull(placeReports.resolvedAt),
      ),
    )
    .limit(1);
  if (!existing) throw new ApiError('internal_error', 'The report could not be recorded.');
  return { report: toPlaceReport(existing), created: false };
}

/** One window of reports in one state, oldest first. */
export async function listPlaceReports(
  db: DatabaseOrTransaction,
  state: PlaceReportState,
  window: TimeWindow,
): Promise<Paged<ModerationPlaceReport>[]> {
  const rows = await db
    .select(REPORT_COLUMNS)
    .from(placeReports)
    .where(
      and(
        state === 'open' ? isNull(placeReports.resolvedAt) : isNotNull(placeReports.resolvedAt),
        createdWindow(placeReports.createdAt, placeReports.id, window),
      ),
    )
    .orderBy(placeReports.createdAt, placeReports.id)
    .limit(window.limit);
  return rows.map((row) => ({ item: toModerationReport(row), position: [row.position, row.id] }));
}

/**
 * Close an open report, and record `report_resolved` on its place.
 *
 * `null` when no report has the id; `conflict` when it is already resolved.
 */
export async function resolvePlaceReport(
  db: Database,
  reportId: string,
  resolution: PlaceReportResolution,
  author: RevisionAuthor,
): Promise<ModerationPlaceReport | null> {
  return db.transaction(async (tx) => {
    const [open] = await tx.select(REPORT_COLUMNS).from(placeReports).where(eq(placeReports.id, reportId)).for('update');
    if (!open) return null;
    if (open.resolvedAt !== null) {
      throw new ApiError('conflict', 'This report is already resolved.', { resolution: open.resolution });
    }
    const [resolved] = await tx
      .update(placeReports)
      .set({ resolution, resolvedAt: new Date(), resolvedByOxyUserId: deciderOf(author) })
      .where(eq(placeReports.id, reportId))
      .returning(REPORT_COLUMNS);
    if (!resolved) return null;

    await recordRevision(tx, {
      placeId: resolved.placeId,
      action: 'report_resolved',
      author,
      changes: [
        {
          field: `reports.${resolved.id}`,
          before: { reason: open.reason, state: 'open' },
          after: { reason: resolved.reason, resolution },
        },
      ],
    });
    return toModerationReport(resolved);
  });
}

// ── Claims ──────────────────────────────────────────────────────────────────

/**
 * Move a claim to `state`, from the one state that decision is allowed from.
 *
 * `decidedAt` is set to now on every decision — it is when the claim's CURRENT
 * state was decided. `null` when no claim has the id; `conflict` when the claim
 * is not in the state the decision starts from (`CLAIM_DECISION_FROM`).
 */
export async function decideClaim(
  db: Database,
  claimId: string,
  state: ClaimDecisionState,
  author: RevisionAuthor,
): Promise<PlaceClaim | null> {
  return db.transaction(async (tx) => {
    const [claim] = await tx.select(CLAIM_COLUMNS).from(placesClaims).where(eq(placesClaims.id, claimId)).for('update');
    if (!claim) return null;
    const from: PlaceClaimState = CLAIM_DECISION_FROM[state];
    if (claim.state !== from) {
      throw new ApiError('conflict', `Only a ${from} claim can be ${state}.`, { state: claim.state });
    }

    const [decided] = await tx
      .update(placesClaims)
      .set({ state, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(placesClaims.id, claimId))
      .returning(CLAIM_COLUMNS);
    if (!decided) return null;

    const snapshot = (row: typeof claim): RevisionValue => ({ oxyAccountId: row.oxyAccountId, role: row.role, state: row.state });
    await recordRevision(tx, {
      placeId: decided.placeId,
      action: `claim_${state}`,
      author,
      changes: [{ field: claimField(decided.id), before: snapshot(claim), after: snapshot(decided) }],
    });
    return toClaim(decided);
  });
}

// ── Places ──────────────────────────────────────────────────────────────────

/**
 * Set what only GoWay may say about a place: its verification state, and
 * whether it is on the map at all.
 *
 * `verifiedAt` is now whenever a verified state is (re)stated, and cleared when
 * the place goes back to `unverified`. A merged place is refused with the same
 * `410` its id answers everywhere: it is not a place any more, it is a pointer.
 *
 * Returns `null` when no place has the id.
 */
export async function moderatePlace(
  db: Database,
  placeId: string,
  input: { status?: ModeratedPlaceStatus | undefined; verificationState?: PlaceVerificationState | undefined },
  author: RevisionAuthor,
): Promise<PlaceLifecycle | null> {
  return db.transaction(async (tx) => {
    const before = await lockPlace(tx, placeId);
    if (!before) return null;
    if (before.status === 'merged') throw unpublishedPlace(lifecycleOf(before));

    const now = new Date();
    const values: { status?: PlaceStatus; verificationState?: PlaceVerificationState; verifiedAt?: Date | null } = {};
    if (input.status !== undefined) values.status = input.status;
    if (input.verificationState !== undefined) {
      values.verificationState = input.verificationState;
      values.verifiedAt = input.verificationState === 'unverified' ? null : now;
    }
    const [after] = await tx
      .update(places)
      .set({ ...values, updatedAt: now })
      .where(eq(places.id, placeId))
      .returning({
        status: places.status,
        mergedIntoPlaceId: places.mergedIntoPlaceId,
        verificationState: places.verificationState,
        verifiedAt: places.verifiedAt,
      });
    if (!after) return null;

    const verification = (row: { verificationState: string; verifiedAt: Date | null }): RevisionValue =>
      row.verifiedAt === null
        ? { state: row.verificationState }
        : { state: row.verificationState, verifiedAt: row.verifiedAt.toISOString() };
    const changes = [
      changeOf('status', before.status, after.status),
      changeOf('verification', verification(before), verification(after)),
    ].filter((change): change is PlaceRevisionChange => change !== null);
    await recordRevision(tx, { placeId, action: 'place_updated', author, changes });
    return { status: after.status as PlaceStatus, mergedIntoPlaceId: after.mergedIntoPlaceId };
  });
}

/**
 * Assert one capability at the `oxy_verified` tier.
 *
 * The one write in this package that produces that tier, and it is reachable
 * only from the operator-gated moderation router. It upserts beside every other
 * tier's row for the key, never over one: an Oxy verification does not erase
 * the community history that prompted it. Returns `false` when no place has the
 * id; a place that is not published is refused with its `410`.
 */
export async function verifyPlaceCapability(
  db: Database,
  placeId: string,
  key: CapabilityKeyParts,
  value: boolean | string | number,
  author: RevisionAuthor,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const place = await lockPlace(tx, placeId);
    if (!place) return false;
    assertPublished(lifecycleOf(place));

    const atTier = and(
      eq(placesCapabilities.placeId, placeId),
      eq(placesCapabilities.namespace, key.namespace),
      eq(placesCapabilities.capability, key.capability),
      eq(placesCapabilities.verification, 'oxy_verified'),
    );
    const [before] = await tx.select(CAPABILITY_COLUMNS).from(placesCapabilities).where(atTier).limit(1);
    const now = new Date();
    const [after] = await tx
      .insert(placesCapabilities)
      .values({ placeId, ...key, value, verification: 'oxy_verified', observedAt: now })
      .onConflictDoUpdate({
        target: [
          placesCapabilities.placeId,
          placesCapabilities.namespace,
          placesCapabilities.capability,
          placesCapabilities.verification,
        ],
        set: { value, observedAt: now, updatedAt: now },
      })
      .returning(CAPABILITY_COLUMNS);
    await tx.update(places).set({ updatedAt: now }).where(eq(places.id, placeId));

    const change = changeOf(
      capabilityField(`${key.namespace}.${key.capability}`),
      before ? capabilitySnapshot(before) : undefined,
      after ? capabilitySnapshot(after) : undefined,
    );
    await recordRevision(tx, { placeId, action: 'capability_asserted', author, changes: change ? [change] : [] });
    return true;
  });
}

/**
 * Withdraw the `oxy_verified` assertion of one capability. `null` when no place
 * has the id; `false` when it carried no such assertion.
 */
export async function withdrawVerifiedCapability(
  db: Database,
  placeId: string,
  key: CapabilityKeyParts,
  author: RevisionAuthor,
): Promise<boolean | null> {
  return db.transaction(async (tx) => {
    const place = await lockPlace(tx, placeId);
    if (!place) return null;
    assertPublished(lifecycleOf(place));
    return deleteCapabilityAtTier(tx, placeId, key, 'oxy_verified', author);
  });
}

// ── Duplicates ──────────────────────────────────────────────────────────────

const CANDIDATE_COLUMNS = {
  id: placesDuplicateCandidates.id,
  placeId: placesDuplicateCandidates.placeId,
  candidatePlaceId: placesDuplicateCandidates.candidatePlaceId,
  reason: placesDuplicateCandidates.reason,
  score: placesDuplicateCandidates.score,
  state: placesDuplicateCandidates.state,
  createdAt: placesDuplicateCandidates.createdAt,
  decidedAt: placesDuplicateCandidates.decidedAt,
  position: sql<string>`${placesDuplicateCandidates.createdAt}::text`,
} as const;

function toCandidate(row: {
  id: string;
  placeId: string;
  candidatePlaceId: string;
  reason: string;
  score: number | null;
  state: string;
  createdAt: Date;
  decidedAt: Date | null;
}): DuplicateCandidate {
  const candidate: DuplicateCandidate = {
    id: row.id,
    placeId: row.placeId,
    candidatePlaceId: row.candidatePlaceId,
    reason: row.reason as DuplicateCandidateReason,
    state: row.state as DuplicateCandidateState,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.score !== null) candidate.score = row.score;
  if (row.decidedAt !== null) candidate.decidedAt = row.decidedAt.toISOString();
  return candidate;
}

/** One window of duplicate candidates in one state, oldest first. */
export async function listDuplicateCandidates(
  db: DatabaseOrTransaction,
  state: DuplicateCandidateState,
  window: TimeWindow,
): Promise<Paged<DuplicateCandidate>[]> {
  const rows = await db
    .select(CANDIDATE_COLUMNS)
    .from(placesDuplicateCandidates)
    .where(
      and(
        eq(placesDuplicateCandidates.state, state),
        createdWindow(placesDuplicateCandidates.createdAt, placesDuplicateCandidates.id, window),
      ),
    )
    .orderBy(placesDuplicateCandidates.createdAt, placesDuplicateCandidates.id)
    .limit(window.limit);
  return rows.map((row) => ({ item: toCandidate(row), position: [row.position, row.id] }));
}

/**
 * Children of the absorbed place whose key the survivor does not already hold.
 *
 * The survivor's own statement wins every collision — its name in a language,
 * its assertion at a tier, an account's claim in a role — and the absorbed row
 * that lost stays where it was, on a place nobody reads any more, rather than
 * being destroyed. Computed from the two places' rows, which the merge has
 * locked; a concurrent importer write that lands a colliding row in between is
 * a unique violation that rolls the whole merge back, never a half-merge.
 */
function movable<T extends { id: string }>(absorbed: readonly T[], survivor: readonly T[], keyOf: (row: T) => string): T[] {
  const held = new Set(survivor.map(keyOf));
  return absorbed.filter((row) => !held.has(keyOf(row)));
}

/**
 * Fold the absorbed place into the survivor.
 *
 *  - Sources MOVE, all of them: `(source, sourceId)` is unique across the table,
 *    so a source can only ever name one place, and the next import of that
 *    OpenStreetMap node has to update the survivor rather than a place nobody
 *    reads.
 *  - Names, capabilities and claims move wherever the survivor holds no row of
 *    its own under the same key ({@link movable}).
 *  - The absorbed place becomes `merged`, pointing at the survivor, and every
 *    place that pointed at the absorbed one now points at the survivor, so a
 *    redirect is always one hop.
 *
 * Each side's history records its half: `place_merged` on the absorbed place
 * (and on any re-pointed one), `place_absorbed` on the survivor with what it
 * received. Claim moves are not itemized in that public revision — claims are
 * never published — and remain readable on the claims themselves.
 */
async function mergePlaces(
  tx: DatabaseOrTransaction,
  survivorId: string,
  absorbedId: string,
  absorbedStatus: PlaceStatus,
  author: RevisionAuthor,
): Promise<void> {
  const now = new Date();
  const received: PlaceRevisionChange[] = [{ field: 'mergedFrom', after: absorbedId }];

  const sources = await tx
    .update(placesSources)
    .set({ placeId: survivorId, updatedAt: now })
    .where(eq(placesSources.placeId, absorbedId))
    .returning({ source: placesSources.source, sourceId: placesSources.sourceId });
  received.push(...sources.map((ref) => ({ field: 'sources', after: { source: ref.source, sourceId: ref.sourceId } })));

  const nameColumns = { id: placesNames.id, placeId: placesNames.placeId, language: placesNames.language, source: placesNames.source, name: placesNames.name };
  const [absorbedNames, survivorNames] = await Promise.all([
    tx.select(nameColumns).from(placesNames).where(eq(placesNames.placeId, absorbedId)),
    tx.select(nameColumns).from(placesNames).where(eq(placesNames.placeId, survivorId)),
  ]);
  const names = movable(absorbedNames, survivorNames, (row) => `${row.language}\u0000${row.source}`);
  if (names.length > 0) {
    await tx.update(placesNames).set({ placeId: survivorId, updatedAt: now }).where(inArray(placesNames.id, names.map((row) => row.id)));
    received.push(...names.map((row) => ({ field: nameField(row.language), after: { name: row.name, source: row.source } })));
  }

  const [absorbedCapabilities, survivorCapabilities] = await Promise.all([
    tx.select(CAPABILITY_COLUMNS).from(placesCapabilities).where(eq(placesCapabilities.placeId, absorbedId)),
    tx.select(CAPABILITY_COLUMNS).from(placesCapabilities).where(eq(placesCapabilities.placeId, survivorId)),
  ]);
  const capabilities = movable(absorbedCapabilities, survivorCapabilities, (row) => `${row.key ?? ''}\u0000${row.verification}`);
  if (capabilities.length > 0) {
    await tx
      .update(placesCapabilities)
      .set({ placeId: survivorId, updatedAt: now })
      .where(inArray(placesCapabilities.id, capabilities.map((row) => row.id)));
    received.push(...capabilities.map((row) => ({ field: capabilityField(row.key ?? `${row.namespace}.${row.capability}`), after: capabilitySnapshot(row) })));
  }

  const [absorbedClaims, survivorClaims] = await Promise.all([
    tx.select(CLAIM_COLUMNS).from(placesClaims).where(eq(placesClaims.placeId, absorbedId)),
    tx.select(CLAIM_COLUMNS).from(placesClaims).where(eq(placesClaims.placeId, survivorId)),
  ]);
  const claims = movable(absorbedClaims, survivorClaims, (row) => `${row.oxyAccountId}\u0000${row.role}`);
  if (claims.length > 0) {
    await tx.update(placesClaims).set({ placeId: survivorId, updatedAt: now }).where(inArray(placesClaims.id, claims.map((row) => row.id)));
  }

  // Everything already merged INTO the absorbed place now points at the survivor.
  const repointed = await tx
    .update(places)
    .set({ mergedIntoPlaceId: survivorId, updatedAt: now })
    .where(eq(places.mergedIntoPlaceId, absorbedId))
    .returning({ id: places.id });
  for (const { id } of repointed) {
    await recordRevision(tx, {
      placeId: id,
      action: 'place_merged',
      author,
      changes: [{ field: 'mergedInto', before: absorbedId, after: survivorId }],
    });
  }

  await tx.update(places).set({ status: 'merged', mergedIntoPlaceId: survivorId, updatedAt: now }).where(eq(places.id, absorbedId));
  await recordRevision(tx, {
    placeId: absorbedId,
    action: 'place_merged',
    author,
    changes: [
      { field: 'status', before: absorbedStatus, after: 'merged' },
      { field: 'mergedInto', after: survivorId },
    ],
  });

  await tx.update(places).set({ updatedAt: now }).where(eq(places.id, survivorId));
  await recordRevision(tx, { placeId: survivorId, action: 'place_absorbed', author, changes: received });
}

/**
 * Decide an open duplicate candidate: merge the pair into the survivor, or keep
 * both.
 *
 * Both places are locked in id order — the order every merge takes them in, so
 * two merges over overlapping pairs cannot deadlock. A merge is refused with
 * `conflict` when either place is already merged or the survivor was removed:
 * a redirect must land on a place somebody can read. `null` when no candidate
 * has the id.
 */
export async function resolveDuplicateCandidate(
  db: Database,
  candidateId: string,
  input: DuplicateResolutionInput,
  author: RevisionAuthor,
): Promise<DuplicateCandidate | null> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select(CANDIDATE_COLUMNS)
      .from(placesDuplicateCandidates)
      .where(eq(placesDuplicateCandidates.id, candidateId))
      .for('update');
    if (!candidate) return null;
    if (candidate.state !== 'open') {
      throw new ApiError('conflict', 'This duplicate candidate is already decided.', { state: candidate.state });
    }
    // Canonical order (`placeId < candidatePlaceId`), which is the id order both places are locked in.
    const pair = [candidate.placeId, candidate.candidatePlaceId] as const;

    let state: DuplicateCandidateState;
    if (input.decision === 'merge') {
      if (!(pair as readonly string[]).includes(input.survivorPlaceId)) {
        throw new ApiError('validation_failed', 'The survivor must be one of the two places in the candidate.', {
          field: 'survivorPlaceId',
          issue: 'not_in_pair',
        });
      }
      const [low, high] = [await lockPlace(tx, pair[0]), await lockPlace(tx, pair[1])];
      const [survivor, absorbed] = input.survivorPlaceId === pair[0] ? [low, high] : [high, low];
      if (!survivor || !absorbed || survivor.status === 'merged' || absorbed.status === 'merged') {
        throw new ApiError('conflict', 'One of the two places has already been merged. Reject this candidate instead.');
      }
      if (survivor.status === 'removed') {
        throw new ApiError('conflict', 'The survivor was removed from GoWay; restore it or merge the other way.');
      }
      await mergePlaces(tx, survivor.id, absorbed.id, absorbed.status, author);
      state = 'confirmed';
    } else {
      for (const [placeId, otherPlaceId] of [pair, [pair[1], pair[0]]] as const) {
        await recordRevision(tx, {
          placeId,
          action: 'duplicate_rejected',
          author,
          changes: [
            {
              field: `duplicates.${candidate.id}`,
              before: { state: 'open', otherPlaceId },
              after: { state: 'rejected', otherPlaceId },
            },
          ],
        });
      }
      state = 'rejected';
    }

    const [decided] = await tx
      .update(placesDuplicateCandidates)
      .set({ state, decidedAt: new Date(), decidedByOxyUserId: deciderOf(author), updatedAt: new Date() })
      .where(eq(placesDuplicateCandidates.id, candidateId))
      .returning(CANDIDATE_COLUMNS);
    return decided ? toCandidate(decided) : null;
  });
}
