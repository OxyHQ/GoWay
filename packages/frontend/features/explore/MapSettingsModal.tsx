/**
 * The map's settings: Bloom's `SettingsModal` — a rail of pages beside the
 * open page on a wide window, the section list and then the page on a phone,
 * native included through Bloom's own modal portal. Loaded on the first press
 * of the gear (`MapSettingsButton.tsx`): the modal links Bloom's settings
 * shell, which the first paint must not carry. It imports the shell's lean
 * entry (`@oxy.so/bloom/settings-modal/modal`), never the `settings-modal`
 * barrel: the barrel also links Bloom's Storage page and with it `Select`,
 * which Oxy's own lazy screens share, so Metro hoists it into the first-paint
 * `__common` chunk (`docs/MAP_FEATURES.md`).
 *
 * The pages and what they list come from the map-feature registry
 * (`lib/map/mapSettingsPages.ts`), never from a list kept here:
 *
 *  - **Map**: the 2D/3D view (the camera, not a feature) and the `map`
 *    features — Globe, Terrain, Sky & time of day (with "Change time…",
 *    which opens the scrubber on the map, while the sky draws), the detailed
 *    city look, street detail — and Performance.
 *  - **Layers**: the `layers` features (Street 3D, 3D city, city tiles and the
 *    official data they carry, trees, simulated traffic, landmarks, the
 *    flyover and Camera Studio); the woods fill and live data only once Labs
 *    is revealed.
 *  - **Labs**, only once revealed: what Labs is, and how to hide it again.
 *  - **General**: the theme (Bloom's own, persisted by `BloomProvider`) and the
 *    language, which follows the device and is shown, not offered.
 *  - **About**: version and build, every credit and licence notice
 *    (`lib/map/credits.ts`, `/attribution`), the landmark models' licences,
 *    and the note that map settings stay on the device.
 *
 * Every switch writes the person's choice through the map-feature store and
 * nothing else; the map applies it itself, live where it can. All copy is in
 * the twelve label languages (`lib/map/mapFeatureLabels.ts`).
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { type Labels, type LiveSource, localizedLabel } from '@goway.to/sdk';
import { Button } from '@oxy.so/bloom/button';
import { RiFlaskLine } from '@oxy.so/bloom/icons/RiFlaskLine';
import { RiInformationLine } from '@oxy.so/bloom/icons/RiInformationLine';
import { RiMap2Line } from '@oxy.so/bloom/icons/RiMap2Line';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiStackLine } from '@oxy.so/bloom/icons/RiStackLine';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import {
  SettingsCard,
  SettingsModal,
  type SettingsModalPage,
  type SettingsNavItem,
  SettingsRow,
  SettingsSection,
  SettingsValueField,
} from '@oxy.so/bloom/settings-modal/modal';
import { Switch } from '@oxy.so/bloom/switch';
import { type ThemeMode, useBloomTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';

import { formatMessage, useTranslation } from '@/lib/i18n';
import { CREDIT_SECTIONS, type CreditSection } from '@/lib/map/credits';
import type { PreparedLandmark } from '@/lib/map/landmarks/load';
import { MAP_FEATURE_LABELS, MAP_SETTINGS_COPY } from '@/lib/map/mapFeatureLabels';
import type { MapFeatureId, MapFeatureState } from '@/lib/map/mapFeatures';
import { type MapSettingsPageId, mapSettingsLayout } from '@/lib/map/mapSettingsPages';
import { MAP_SETTINGS_TRIGGER_LABEL } from '@/lib/map/mapSettingsTriggerLabel';
import { MAP_LIGHT_MODE_LABELS, MAP_STYLE_COPY, MAP_STYLE_LABELS } from '@/lib/map/mapStyleLabels';
import type { PerformanceMode } from '@/lib/map/quality/profile';
import { MAP_LIGHT_MODES, type MapLightMode, mapStyleDefinition } from '@/lib/map/style/catalogue';
import { mapFeatureStore, useMapFeatures } from '@/lib/map/useMapFeatures';

// The style picker ships in this chunk: one lazy chunk for the map's panels,
// so the labels they share never land in the first-paint bundle.
export { MapStylePicker } from './MapStylePicker';

export interface MapSettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** The page to open on (Labs, when it was just revealed). */
  initialPage?: MapSettingsPageId;
  /** Whether the camera is tilted — the 2D/3D control's value. */
  tilted: boolean;
  /** Tilt the camera to 3D, or level it to 2D. */
  onTiltChange: (tilted: boolean) => void;
  /**
   * Close the modal and open the time-of-day scrubber on the map. Passed only
   * while the sky draws, so "Change time…" is offered only then.
   */
  onChangeTime?: () => void;
  /** Close the modal and open the style picker on the map ("Style → Choose…"). */
  onChooseStyle?: () => void;
}

type ViewMode = '2d' | '3d';
type Say = (labels: Labels) => string;

/** Settings → Map → Performance (`lib/map/quality/profile.ts`, `docs/MAP_PERFORMANCE.md`). */
const PERFORMANCE_CHOICES = [
  ['auto', 'performanceAuto'],
  ['battery', 'performanceBattery'],
  ['high', 'performanceHigh'],
] as const satisfies readonly (readonly [PerformanceMode, keyof typeof MAP_SETTINGS_COPY])[];

/** The theme modes GoWay offers: Bloom's, less `adaptive` (no seed to adapt to). */
const THEME_MODES = [
  ['light', 'themeLight'],
  ['dark', 'themeDark'],
  ['system', 'themeSystem'],
] as const satisfies readonly (readonly [ThemeMode, keyof typeof MAP_SETTINGS_COPY])[];

const PAGE_ICONS = {
  map: RiMap2Line,
  layers: RiStackLine,
  labs: RiFlaskLine,
  general: RiSettings3Line,
  about: RiInformationLine,
} satisfies Record<MapSettingsPageId, SettingsNavItem['icon']>;

const PAGE_TITLES = {
  map: MAP_SETTINGS_COPY.map,
  layers: MAP_SETTINGS_COPY.layers,
  labs: MAP_SETTINGS_COPY.labs,
  general: MAP_SETTINGS_COPY.general,
  about: MAP_SETTINGS_COPY.about,
} satisfies Record<MapSettingsPageId, Labels>;

/** Each credit section's heading, and its one-line body where it has one. */
const CREDIT_HEADINGS = {
  basemap: MAP_SETTINGS_COPY.creditsBasemap,
  elevation: MAP_SETTINGS_COPY.creditsElevation,
  buildings: MAP_SETTINGS_COPY.creditsBuildings,
  cityData: MAP_SETTINGS_COPY.creditsCityData,
  models: MAP_SETTINGS_COPY.creditsModels,
} satisfies Record<CreditSection['id'], Labels>;

const CREDIT_BODIES: Record<CreditSection['id'], Labels | null> = {
  basemap: MAP_SETTINGS_COPY.creditsBasemapBody,
  elevation: null,
  buildings: MAP_SETTINGS_COPY.creditsBuildingsBody,
  cityData: MAP_SETTINGS_COPY.creditsCityDataBody,
  models: MAP_SETTINGS_COPY.creditsModelsBody,
};

function openLink(href: string) {
  void Linking.openURL(href).catch(() => {
    // An unopenable credit link must not take the modal down with it.
  });
}

/** The device's language in its own words (`Español (México)`), or its tag. */
function languageName(locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(locale);
    return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : locale;
  } catch {
    return locale;
  }
}

/** The landmark models, read through the registry's own lazy chunk. */
function useLandmarkModels(): readonly PreparedLandmark[] {
  const [models, setModels] = useState<readonly PreparedLandmark[]>([]);
  useEffect(() => {
    let live = true;
    const origin = typeof window !== 'undefined' && window.location ? window.location.origin : '';
    void import('@/lib/map/landmarks/load')
      .then(({ loadLandmarks }) => loadLandmarks(origin))
      .then((list) => {
        if (live) setModels(list);
      });
    return () => {
      live = false;
    };
  }, []);
  return models;
}

/**
 * GoWay Live's feeds — each one's credit and licence — while live is on; the
 * same list `GET /live/sources` serves (`docs/MAP_LIVE.md`). Empty when off or
 * when the backend has no live layer.
 */
function useLiveSources(on: boolean): readonly LiveSource[] {
  const [sources, setSources] = useState<readonly LiveSource[]>([]);
  useEffect(() => {
    if (!on) return;
    let current = true;
    void import('@/lib/live/client')
      .then(({ liveApiClient }) => liveApiClient.live.sources())
      .then((page) => {
        if (current) setSources(page.items);
      })
      .catch(() => {
        // No live layer on this backend: nothing to credit.
      });
    return () => {
      current = false;
    };
  }, [on]);
  // Off, nothing is credited — whatever an earlier fetch returned.
  return on ? sources : NO_LIVE_SOURCES;
}

const NO_LIVE_SOURCES: readonly LiveSource[] = [];

export function MapSettingsModal({
  open,
  onClose,
  initialPage,
  tilted,
  onTiltChange,
  onChangeTime,
  onChooseStyle,
}: MapSettingsModalProps) {
  const { locale } = useTranslation();
  const router = useRouter();
  const { mode, setMode } = useBloomTheme();
  const { features, labs, performance, style, light } = useMapFeatures();
  const styleFixed = mapStyleDefinition(style).light === 'fixed';
  const landmarks = useLandmarkModels();
  const liveSources = useLiveSources(features.on('live'));
  const say = useCallback<Say>((labels) => localizedLabel(labels, locale), [locale]);
  const layout = mapSettingsLayout(features, labs);

  const navigate = useCallback(
    (path: '/studio' | '/attribution') => {
      onClose();
      router.push(path);
    },
    [onClose, router],
  );

  const version = Constants.expoConfig?.version ?? '—';
  const build = `${Platform.OS} · ${say(
    __DEV__ ? MAP_SETTINGS_COPY.buildDevelopment : MAP_SETTINGS_COPY.buildRelease,
  )}`;

  const content: Record<MapSettingsPageId, React.ReactNode> = {
    map: (
      <View className="gap-space-24">
        <SettingsCard>
          <SettingsRow label={say(MAP_SETTINGS_COPY.view)} testID="map-settings-view-row">
            <SegmentedControl<ViewMode>
              type="radio"
              size="sm"
              label={say(MAP_SETTINGS_COPY.view)}
              value={tilted ? '3d' : '2d'}
              onValueChange={(next) => onTiltChange(next === '3d')}
              testID="map-settings-view"
            >
              <SegmentedControlItem
                value="2d"
                accessibilityHint={say(MAP_SETTINGS_COPY.flatHint)}
                testID="map-settings-view-2d"
              >
                <SegmentedControlItemText>{say(MAP_SETTINGS_COPY.flat)}</SegmentedControlItemText>
              </SegmentedControlItem>
              <SegmentedControlItem
                value="3d"
                accessibilityHint={say(MAP_SETTINGS_COPY.tiltedHint)}
                testID="map-settings-view-3d"
              >
                <SegmentedControlItemText>{say(MAP_SETTINGS_COPY.tilted)}</SegmentedControlItemText>
              </SegmentedControlItem>
            </SegmentedControl>
          </SettingsRow>
          {layout.features.map.map((state) => (
            <Fragment key={state.id}>
              <FeatureRow state={state} say={say} />
              {state.id === 'citySky' && state.on && onChangeTime ? (
                <SettingsRow
                  label={say(MAP_SETTINGS_COPY.timeOfDay)}
                  description={say(MAP_SETTINGS_COPY.timeOfDayHint)}
                  testID="map-settings-time-of-day-row"
                >
                  <Button
                    size="sm"
                    appearance="outline"
                    onPress={onChangeTime}
                    testID="map-settings-change-time"
                  >
                    {say(MAP_SETTINGS_COPY.changeTime)}
                  </Button>
                </SettingsRow>
              ) : null}
            </Fragment>
          ))}
        </SettingsCard>
        <SettingsSection
          description={say(styleFixed ? MAP_STYLE_COPY.fixedLight : MAP_STYLE_COPY.lightHint)}
        >
          <SettingsCard>
            <SettingsRow
              label={say(MAP_STYLE_COPY.style)}
              description={say(MAP_STYLE_LABELS[style].name)}
              testID="map-settings-style-row"
            >
              {onChooseStyle ? (
                <Button
                  size="sm"
                  appearance="outline"
                  onPress={onChooseStyle}
                  testID="map-settings-choose-style"
                >
                  {say(MAP_STYLE_COPY.choose)}
                </Button>
              ) : null}
            </SettingsRow>
            <SettingsRow label={say(MAP_STYLE_COPY.light)} testID="map-settings-light-row">
              <SegmentedControl<MapLightMode>
                type="radio"
                size="sm"
                label={say(MAP_STYLE_COPY.light)}
                value={light}
                disabled={styleFixed}
                onValueChange={(mode) => mapFeatureStore.setLight(mode)}
                testID="map-settings-light"
              >
                {MAP_LIGHT_MODES.map((mode) => (
                  <SegmentedControlItem
                    key={mode}
                    value={mode}
                    testID={`map-settings-light-${mode}`}
                  >
                    <SegmentedControlItemText>
                      {say(MAP_LIGHT_MODE_LABELS[mode])}
                    </SegmentedControlItemText>
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
        <SettingsSection description={say(MAP_SETTINGS_COPY.performanceHint)}>
          <SettingsCard>
            <SettingsRow
              label={say(MAP_SETTINGS_COPY.performance)}
              testID="map-settings-performance-row"
            >
              <SegmentedControl<PerformanceMode>
                type="radio"
                size="sm"
                label={say(MAP_SETTINGS_COPY.performance)}
                value={performance}
                onValueChange={(mode) => mapFeatureStore.setPerformance(mode)}
                testID="map-settings-performance"
              >
                {PERFORMANCE_CHOICES.map(([value, key]) => (
                  <SegmentedControlItem
                    key={value}
                    value={value}
                    testID={`map-settings-performance-${value}`}
                  >
                    <SegmentedControlItemText>
                      {say(MAP_SETTINGS_COPY[key])}
                    </SegmentedControlItemText>
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </View>
    ),
    // Most layers are on for everyone now: the "experimental" note belongs to
    // the Labs page alone.
    layers: (
      <SettingsSection>
        <SettingsCard>
          {layout.features.layers.map((state) => (
            <FeatureRow key={state.id} state={state} say={say} />
          ))}
          {features.on('flyover') ? (
            <SettingsRow label={say(MAP_SETTINGS_COPY.studio)}>
              <Button
                size="sm"
                appearance="outline"
                onPress={() => navigate('/studio')}
                testID="map-settings-open-studio"
              >
                {say(MAP_SETTINGS_COPY.open)}
              </Button>
            </SettingsRow>
          ) : null}
        </SettingsCard>
      </SettingsSection>
    ),
    labs: (
      <SettingsSection description={say(MAP_SETTINGS_COPY.labsHint)}>
        <SettingsCard>
          <SettingsRow label={say(MAP_SETTINGS_COPY.hideLabs)}>
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              onPress={() => mapFeatureStore.setLabs(false)}
              testID="map-settings-hide-labs"
            >
              {say(MAP_SETTINGS_COPY.hideLabs)}
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    ),
    general: (
      <SettingsCard>
        <SettingsRow label={say(MAP_SETTINGS_COPY.appearance)}>
          <SegmentedControl<ThemeMode>
            type="radio"
            size="sm"
            label={say(MAP_SETTINGS_COPY.appearance)}
            value={mode === 'adaptive' ? 'system' : mode}
            onValueChange={setMode}
            testID="map-settings-theme"
          >
            {THEME_MODES.map(([value, key]) => (
              <SegmentedControlItem
                key={value}
                value={value}
                testID={`map-settings-theme-${value}`}
              >
                <SegmentedControlItemText>{say(MAP_SETTINGS_COPY[key])}</SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </SettingsRow>
        <SettingsRow
          label={say(MAP_SETTINGS_COPY.language)}
          description={say(MAP_SETTINGS_COPY.languageHint)}
        >
          <SettingsValueField muted>{languageName(locale)}</SettingsValueField>
        </SettingsRow>
      </SettingsCard>
    ),
    about: (
      <View className="gap-space-24">
        <SettingsSection description={say(MAP_SETTINGS_COPY.privacy)}>
          <SettingsCard>
            <SettingsRow label={say(MAP_SETTINGS_COPY.version)}>
              <SettingsValueField muted>{version}</SettingsValueField>
            </SettingsRow>
            <SettingsRow label={say(MAP_SETTINGS_COPY.build)}>
              <SettingsValueField muted>{build}</SettingsValueField>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        {CREDIT_SECTIONS.map((section) => (
          <SettingsSection
            key={section.id}
            label={say(CREDIT_HEADINGS[section.id])}
            description={
              CREDIT_BODIES[section.id] ? say(CREDIT_BODIES[section.id] as Labels) : undefined
            }
            testID={`map-settings-credit-${section.id}`}
          >
            <SettingsCard>
              {section.links.map((link) => (
                <SettingsRow key={link.href} label={link.label}>
                  <Button
                    size="sm"
                    appearance="plain"
                    tone="neutral"
                    accessibilityRole="link"
                    accessibilityLabel={`${say(MAP_SETTINGS_COPY.open)} ${link.label}`}
                    onPress={() => openLink(link.href)}
                  >
                    {say(MAP_SETTINGS_COPY.open)}
                  </Button>
                </SettingsRow>
              ))}
            </SettingsCard>
            {section.notices.map((notice) => (
              // Verbatim, in the licensor's language: a licence notice is quoted.
              <Text
                key={notice}
                className="px-space-12 pt-space-8 text-caption text-muted-foreground"
              >
                {notice}
              </Text>
            ))}
          </SettingsSection>
        ))}

        <SettingsCard>
          <SettingsRow label={say(MAP_SETTINGS_COPY.creditsAll)}>
            <Button
              size="sm"
              appearance="outline"
              accessibilityRole="link"
              onPress={() => navigate('/attribution')}
              testID="map-settings-attribution"
            >
              {say(MAP_SETTINGS_COPY.open)}
            </Button>
          </SettingsRow>
        </SettingsCard>

        {liveSources.length > 0 ? (
          <SettingsSection
            label={say(MAP_SETTINGS_COPY.liveSources)}
            testID="map-settings-live-sources"
          >
            <SettingsCard>
              {liveSources.map((source) => (
                <SettingsRow key={source.id} label={source.name}>
                  <View className="flex-row flex-wrap justify-end">
                    {[source.attribution, source.licence].map((link) => (
                      <Button
                        key={link.href}
                        size="sm"
                        appearance="plain"
                        tone="neutral"
                        accessibilityRole="link"
                        onPress={() => openLink(link.href)}
                      >
                        {link.label}
                      </Button>
                    ))}
                  </View>
                </SettingsRow>
              ))}
            </SettingsCard>
          </SettingsSection>
        ) : null}

        {landmarks.length > 0 ? (
          <SettingsSection label={say(MAP_SETTINGS_COPY.landmarkModels)}>
            <SettingsCard>
              {landmarks.map(({ entry }) => (
                <SettingsRow
                  key={entry.id}
                  label={entry.name}
                  description={`${entry.licence.spdx} · ${entry.licence.author}`}
                >
                  {/^https:\/\//.test(entry.licence.source) ? (
                    <Button
                      size="sm"
                      appearance="plain"
                      tone="neutral"
                      accessibilityRole="link"
                      accessibilityLabel={`${say(MAP_SETTINGS_COPY.open)} ${entry.name}`}
                      onPress={() => openLink(entry.licence.source)}
                    >
                      {say(MAP_SETTINGS_COPY.open)}
                    </Button>
                  ) : null}
                </SettingsRow>
              ))}
            </SettingsCard>
          </SettingsSection>
        ) : null}
      </View>
    ),
  };

  const pages = Object.fromEntries(
    layout.pages.map((id) => [id, { title: say(PAGE_TITLES[id]), content: content[id] }]),
  ) as Record<string, SettingsModalPage>;

  const groups = useMemo(
    () => [
      {
        key: 'settings',
        label: say(MAP_SETTINGS_COPY.settings),
        items: layout.pages.map(
          (id): SettingsNavItem => ({
            key: id,
            label: say(PAGE_TITLES[id]),
            icon: PAGE_ICONS[id],
            page: id,
          }),
        ),
      },
    ],
    [layout.pages, say],
  );

  return (
    <SettingsModal
      open={open}
      onClose={onClose}
      groups={groups}
      pages={pages}
      defaultPage={initialPage && layout.pages.includes(initialPage) ? initialPage : 'map'}
      initialView={initialPage ? 'page' : 'navigation'}
      labels={{
        dialog: say(MAP_SETTINGS_TRIGGER_LABEL),
        nav: say(MAP_SETTINGS_COPY.sections),
        close: say(MAP_SETTINGS_COPY.close),
        back: say(MAP_SETTINGS_COPY.back),
      }}
      testID="map-settings-modal"
    />
  );
}

function FeatureRow({ state, say }: { state: MapFeatureState; say: Say }) {
  const labels = MAP_FEATURE_LABELS[state.id as MapFeatureId];
  const name = say(labels.name);
  const blocked = state.blockedBy.length > 0;
  const fromPage = state.source === 'page';
  const note = blocked
    ? formatMessage(say(MAP_SETTINGS_COPY.requires), {
        feature: state.blockedBy
          .map((id) => say(MAP_FEATURE_LABELS[id as MapFeatureId].name))
          .join(', '),
      })
    : fromPage
      ? say(MAP_SETTINGS_COPY.setByPage)
      : null;
  const description = note ? `${say(labels.description)} ${note}.` : say(labels.description);

  return (
    <SettingsRow label={name} description={description} testID={`map-settings-feature-${state.id}`}>
      <Switch
        checked={state.on}
        disabled={blocked || fromPage}
        onCheckedChange={(on) => mapFeatureStore.setChoice(state.id, on)}
        accessibilityLabel={name}
        testID={`map-settings-switch-${state.id}`}
      />
    </SettingsRow>
  );
}
