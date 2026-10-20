/**
 * The save state of one place and what to do about it, for a heart or a Save
 * button — one rule for every place the app draws one.
 *
 *  - saved   = some list of the person's holds it (`useSavedHold`, batched
 *              across every heart on screen);
 *  - press   = signed out: the auth gate opens the Oxy dialog and nothing
 *              else happens; saved: edit lists in the picker; not saved: for a
 *              heart, one tap saves to the default list (created on the first
 *              save), for a button, open the picker.
 *  - un-heart = removes the place when it is in exactly ONE list; with several
 *              the person chooses in the picker, since "remove everywhere"
 *              would delete more than one tap can mean.
 *
 * The picker is mounted only while open (`dialog`), and a failed one-tap save
 * says so in a toast: the heart has no room for a sentence.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { toast } from '@oxy.so/bloom/toast';
import type { PlaceId } from '@goway.to/sdk';

import { useAuthGate } from '@/lib/authGate';
import { useRemoveSavedItem, useSavedHold, useSavePlace } from '@/lib/goway/saved';
import { useTranslation } from '@/lib/i18n';

import { savedFailureMessage } from './savedErrors';
import { SavePlaceDialog } from './SavePlaceDialog';

export interface SaveControl {
  /** Whether any of the person's lists holds the place. Always `false` signed out. */
  saved: boolean;
  /** The heart: save to the default list, or remove from the only list holding it. */
  onFavoriteChange: (next: boolean) => void;
  /** The Save button: choose lists. Gated on sign-in. */
  openPicker: () => void;
  /** The heart's two accessible names, in the reader's language. */
  saveLabel: string;
  removeLabel: string;
  /** The picker, mounted while open. Render it anywhere in the tree. */
  dialog: ReactNode;
}

export function useSaveControl(place: { id: PlaceId; name: string }, enabled = true): SaveControl {
  const { t } = useTranslation();
  const gate = useAuthGate();
  const hold = useSavedHold(place.id, enabled && gate.canUsePrivateApi);
  const save = useSavePlace();
  const remove = useRemoveSavedItem();
  const [open, setOpen] = useState(false);

  const holds = hold.data?.lists ?? [];
  const saved = holds.length > 0;

  const fail = useCallback(
    (error: Error) => {
      toast.error(savedFailureMessage(error, t));
    },
    [t],
  );

  const onFavoriteChange = useCallback(
    (next: boolean) => {
      gate.run(() => {
        if (next) {
          save.mutate(
            { placeId: place.id, defaultName: t('saved.defaultName') },
            { onError: fail },
          );
          return;
        }
        const only = holds.length === 1 ? holds[0] : undefined;
        if (only) remove.mutate(only, { onError: fail });
        else setOpen(true);
      });
    },
    [fail, gate, holds, place.id, remove, save, t],
  );

  const openPicker = useCallback(() => {
    gate.run(() => setOpen(true));
  }, [gate]);

  const close = useCallback(() => setOpen(false), []);

  return {
    saved,
    onFavoriteChange,
    openPicker,
    saveLabel: t('saved.heart.save'),
    removeLabel: t('saved.heart.remove'),
    dialog: open ? (
      <SavePlaceDialog placeId={place.id} placeName={place.name} onClose={close} />
    ) : null,
  };
}
