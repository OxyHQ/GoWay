/**
 * The body of the map's settings dialog (`MapSettingsButton.tsx`), loaded on
 * first open. Four sections, top to bottom:
 *
 *  - **Map**: how it is seen (2D or 3D — the camera, not a feature) and the
 *    registry's `stable` features (globe, terrain).
 *  - **Layers**, once Labs is revealed: the `labs` features, each with what it
 *    shows and the note that they may be slow; "Open Camera Studio" while the
 *    flyover is on; "Hide Labs".
 *  - **General**: what GoWay already lets a person set — the theme (Bloom's own,
 *    persisted by `BloomProvider`) — and the language, which follows the device
 *    and is shown, not offered.
 *  - **About**: the version and build, every credit with its links and the
 *    licence notices (`lib/map/credits.ts`, the full page at `/attribution`),
 *    the landmark models' licences, and the privacy note.
 *
 * Every feature switch writes the person's choice through the map-feature
 * store and nothing else; the map applies it itself, live where it can
 * (`docs/MAP_FEATURES.md`). Nothing here leaves the device.
 */
import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { type Labels, localizedLabel } from '@goway.to/sdk';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { type ThemeMode, useBloomTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';

import { formatMessage, useTranslation } from '@/lib/i18n';
import { CREDIT_SECTIONS, type CreditLink } from '@/lib/map/credits';
import type { PreparedLandmark } from '@/lib/map/landmarks/load';
import { MAP_FEATURE_LABELS, MAP_SETTINGS_COPY } from '@/lib/map/mapFeatureLabels';
import type { MapFeatureId, MapFeatureState } from '@/lib/map/mapFeatures';
import { mapFeatureStore, useMapFeatures } from '@/lib/map/useMapFeatures';

export interface MapSettingsPanelProps {
  tilted: boolean;
  onTiltChange: (tilted: boolean) => void;
  /** Close the dialog — before navigating away from the map. */
  onClose: () => void;
}

type ViewMode = '2d' | '3d';
type Say = (labels: Labels) => string;

/** The theme modes GoWay offers: Bloom's, less `adaptive` (no seed to adapt to). */
const THEME_MODES = [
  ['light', 'themeLight'],
  ['dark', 'themeDark'],
  ['system', 'themeSystem'],
] as const satisfies readonly (readonly [ThemeMode, keyof typeof MAP_SETTINGS_COPY])[];

function openLink(href: string) {
  void Linking.openURL(href).catch(() => {
    // An unopenable credit link must not take the dialog down with it.
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

export function MapSettingsPanel({ tilted, onTiltChange, onClose }: MapSettingsPanelProps) {
  const { locale } = useTranslation();
  const router = useRouter();
  const { mode, setMode } = useBloomTheme();
  const { features, labs } = useMapFeatures();
  const landmarks = useLandmarkModels();
  const say = useCallback<Say>((labels) => localizedLabel(labels, locale), [locale]);

  const offered = features.list.filter((state) => state.available);
  const stable = offered.filter((state) => state.tier === 'stable');
  const experimental = offered.filter((state) => state.tier === 'labs');

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

  return (
    <View className="gap-space-16 pb-space-8">
      {/* --- Map ---------------------------------------------------------- */}
      <SettingsListGroup title={say(MAP_SETTINGS_COPY.map)}>
        <View className="gap-space-8 px-space-16 py-space-12">
          <Text className="text-body text-foreground">{say(MAP_SETTINGS_COPY.view)}</Text>
          <SegmentedControl<ViewMode>
            type="radio"
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
        </View>
        {stable.map((state) => (
          <FeatureRow key={state.id} state={state} say={say} />
        ))}
      </SettingsListGroup>

      {/* --- Layers (Labs) ------------------------------------------------- */}
      {labs && experimental.length > 0 ? (
        <SettingsListGroup
          title={`${say(MAP_SETTINGS_COPY.layers)} · ${say(MAP_SETTINGS_COPY.labs)}`}
          footer={say(MAP_SETTINGS_COPY.labsHint)}
        >
          {experimental.map((state) => (
            <FeatureRow key={state.id} state={state} say={say} />
          ))}
          {features.on('flyover') ? (
            <SettingsListItem
              title={say(MAP_SETTINGS_COPY.studio)}
              showChevron
              onPress={() => navigate('/studio')}
            />
          ) : null}
          <SettingsListItem
            title={say(MAP_SETTINGS_COPY.hideLabs)}
            onPress={() => mapFeatureStore.setLabs(false)}
          />
        </SettingsListGroup>
      ) : null}

      {/* --- General -------------------------------------------------------- */}
      <SettingsListGroup title={say(MAP_SETTINGS_COPY.general)}>
        <View className="gap-space-8 px-space-16 py-space-12">
          <Text className="text-body text-foreground">{say(MAP_SETTINGS_COPY.appearance)}</Text>
          <SegmentedControl<ThemeMode>
            type="radio"
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
        </View>
        <SettingsListItem
          title={say(MAP_SETTINGS_COPY.language)}
          description={say(MAP_SETTINGS_COPY.languageHint)}
          value={languageName(locale)}
        />
      </SettingsListGroup>

      {/* --- About ---------------------------------------------------------- */}
      <SettingsListGroup
        title={say(MAP_SETTINGS_COPY.about)}
        footer={say(MAP_SETTINGS_COPY.privacy)}
      >
        <SettingsListItem title={say(MAP_SETTINGS_COPY.version)} value={version} />
        <SettingsListItem title={say(MAP_SETTINGS_COPY.build)} value={build} />
      </SettingsListGroup>

      <SettingsListGroup title={say(MAP_SETTINGS_COPY.credits)}>
        {CREDIT_SECTIONS.map((section) => (
          <CreditBlock
            key={section.id}
            heading={say(
              section.id === 'basemap'
                ? MAP_SETTINGS_COPY.creditsBasemap
                : MAP_SETTINGS_COPY.creditsElevation,
            )}
            body={section.id === 'basemap' ? say(MAP_SETTINGS_COPY.creditsBasemapBody) : null}
            links={section.links}
            notices={section.notices}
          />
        ))}
        <SettingsListItem
          title={say(MAP_SETTINGS_COPY.creditsAll)}
          showChevron
          accessibilityRole="link"
          onPress={() => navigate('/attribution')}
        />
      </SettingsListGroup>

      {landmarks.length > 0 ? (
        <SettingsListGroup title={say(MAP_SETTINGS_COPY.landmarkModels)}>
          {landmarks.map(({ entry }) => (
            <SettingsListItem
              key={entry.id}
              title={entry.name}
              description={`${entry.licence.spdx} · ${entry.licence.author}`}
              accessibilityRole={/^https:\/\//.test(entry.licence.source) ? 'link' : 'none'}
              onPress={
                /^https:\/\//.test(entry.licence.source)
                  ? () => openLink(entry.licence.source)
                  : undefined
              }
            />
          ))}
        </SettingsListGroup>
      ) : null}
    </View>
  );
}

function CreditBlock({
  heading,
  body,
  links,
  notices,
}: {
  heading: string;
  body: string | null;
  links: readonly CreditLink[];
  notices: readonly string[];
}) {
  return (
    <View className="gap-space-4 px-space-16 py-space-12">
      <Text className="text-body text-foreground">{heading}</Text>
      {body ? <Text className="text-bodySmall text-muted-foreground">{body}</Text> : null}
      <View className="flex-row flex-wrap gap-x-space-12 gap-y-space-4">
        {links.map((link) => (
          <Text
            key={link.href}
            accessibilityRole="link"
            onPress={() => openLink(link.href)}
            className="text-bodySmall text-foreground underline"
          >
            {link.label}
          </Text>
        ))}
      </View>
      {notices.map((notice) => (
        // Verbatim, in the licensor's language: a licence notice is quoted.
        <Text key={notice} className="text-caption text-muted-foreground">
          {notice}
        </Text>
      ))}
    </View>
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

  return (
    <View
      className="flex-row items-center gap-space-12 px-space-16 py-space-12"
      testID={`map-settings-feature-${state.id}`}
    >
      <View className="flex-1 gap-space-2">
        <Text className="text-body text-foreground">{name}</Text>
        <Text className="text-bodySmall text-muted-foreground">{say(labels.description)}</Text>
        {note ? <Text className="text-caption text-muted-foreground">{note}</Text> : null}
      </View>
      <Switch
        checked={state.on}
        disabled={blocked || fromPage}
        onCheckedChange={(on) => mapFeatureStore.setChoice(state.id, on)}
        accessibilityLabel={name}
        testID={`map-settings-switch-${state.id}`}
      />
    </View>
  );
}
