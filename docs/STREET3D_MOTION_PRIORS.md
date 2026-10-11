# Street 3D motion priors

Part of [#11](https://github.com/OxyHQ/GoWay/issues/11): giving GoWay's own camera
solve better priors from the contributor's phone. No third-party SLAM or
positioning service is involved, and none may be: every frame goes through the
privacy pipeline ([`STREET3D_PIPELINE.md`](./STREET3D_PIPELINE.md)) and nothing
leaves GoWay's own systems.

**What shipped:** a guided recording on iOS or Android samples the phone's
**gravity** (its direction only) while it records. The backend turns it into
one measured gravity per privacy-safe keyframe, and the worker uses it to decide
which way is up when it places the solved scene on the map. **What did not:**
feeding gravity into COLMAP's mapper (measured to change nothing when the
prior is right and to break registration when it is wrong), and true
visual-inertial poses (a native module; see [the follow-up](#follow-up-visual-inertial-poses)).

## Findings

File references are to `origin/main` at `55614bc`, before this change.

### How capture works

- **Three ways in.** `ContributeScreen.tsx` picks from the library
  (`launchImageLibraryAsync`, :136), shoots through the system camera
  (`launchCameraAsync`, :130) or opens the guided camera (`GuidedCapture`).
  Only the guided camera is GoWay's own code while the shutter is open:
  `GuidedCapture.native.tsx` records with `expo-camera`'s
  `CameraView.recordAsync` (:138), and `GuidedCapture.web.tsx` with
  `MediaRecorder`.
- **Position.** Location is asked for only when the contributor taps Start
  (`guidedStarted`, `ContributeScreen.tsx:186`–`214`) or "use my location"
  (:272); a library photo contributes the coordinate in its EXIF
  (`mediaLocation`, `media.shared.ts:104`–`118`). One position per ASSET.
- **Orientation.** The app is portrait-locked. On iOS `expo-camera` reports
  the physical orientation from its own accelerometer check
  (`onResponsiveOrientationChanged`, `GuidedCapture.native.tsx:221`–`222`) and
  records in it (`expo-camera` 57.0.6 `CameraVideoRecording.swift`: the
  connection's `videoOrientation` is set from `physicalOrientation` when
  `responsiveOrientationWhenOrientationLocked`). On Android the video use case
  keeps CameraX's default target rotation, the display's, so a recording is
  always in the device's natural orientation (`ExpoCameraView.kt`
  `createVideoCapture`; only image capture and analysis follow the
  orientation listener).

### What metadata travels today

- **Per capture, from the app:** `capturedAt`, `location[]`, and `camera`
  (`widthPixels`, `heightPixels`, `durationSeconds`, `frameRate`;
  `ContributeScreen.tsx:322`). Contract: `captureAssetInputSchema`
  (`packages/contracts/src/capture.ts:771`) with
  `captureCameraInputSchema` (:733) and `captureLocationEvidenceInputSchema`
  (:716, `headingDegrees` at :723).
- **Per frame, from the privacy worker:** `PrivacyFrame` (worker
  `contract.py:232`–`246`) reports size, detections, sharpness,
  `timestampSeconds` for a video keyframe, and `panorama` for a 360° view.
  The backend's `privacyFrameSchema` did not read `timestampSeconds`, and
  `capture_derivatives` stored no time.
- **Per frame, into the solve:** the manifest's `InputFrame`
  (`contract.py:155`–`170`; backend `manifestFrameSchema`,
  `workerContract.ts:167`–`194`) carries the position prior (with optional
  `headingDegrees`), `camera.focalLength35mm` and `panorama`. Nothing about
  the camera's attitude.

### How `heading` gets from the phone to `SfmFrame`

It mostly does not. `headingDegrees` enters only as a location-evidence claim
— sent directly, or as `exifGps.imageDirection` normalized in
`evidenceFromClaim` (`backend/src/capture/exif.ts:148`–`155`). The GoWay app
sends neither: `mediaLocation` returns a coordinate only, and the guided
capture sends `device_capture` without a heading. Where a claim has one,
`loadEligibleFrames` picks the best evidence's heading for the whole asset
(`db/street3d/scenes.ts:120`), `frameHeading` adds a 360° view's yaw
(`street3d/formation.ts:76`), the manifest carries it (:153), the worker copies
it into `SfmFrame.heading` (`recon/job.py:203`), and `sfm.py` uses it in ONE
place: skipping cross-sequence pairs of 360° views that face apart
(`_cross_allowed`, `sfm.py:191`). It is never a prior in the solve itself.

### What pycolmap 4.2.1 accepts

Read from the installed package (`pycolmap/_core/__init__.pyi`) and exercised,
not taken from documentation:

| Prior | API | Used by |
| --- | --- | --- |
| Camera position | `PosePrior.position` (+ `position_covariance`, `coordinate_system` WGS84/CARTESIAN) | incremental mapping with `IncrementalPipelineOptions.use_prior_position`; `create_pose_prior_bundle_adjuster` |
| Gravity | `PosePrior.gravity` (`has_gravity()`) | global mapping, `mapper.rotation_averaging.use_gravity` (+ `gravity_dir`, `use_stratified` for mixed sets); `run_gravity_refinement`; `compute_rot90_from_gravity` |
| Rig rotation | `RigConfig` / `apply_rig_config`, `refine_sensor_from_rig` | already used for 360° views |
| Full pose | `cost_functions.AbsolutePosePriorCost`, `RelativePosePriorCost` | only in a hand-built `pyceres` problem; no stock mapper takes a rotation prior |

The gravity convention was established with `synthesize_dataset(prior_gravity=True)`:
`PosePrior.gravity == cam_from_world.rotation · [0, 1, 0]` — a unit vector
pointing DOWN in the camera's axes (x right, y down, z forward), with world
gravity along +y. That is the convention this change uses end to end.

### Whether a gravity prior helps COLMAP's mapper

Measured on `pycolmap.synthesize_dataset` scenes (30–80 frames, exhaustive,
chained and sparse matching, up to 70 % outlier matches, 3 px noise; three or
four seeds each), global mapping with and without `use_gravity`, priors with 1° noise:

| Case | Median rotation error | Registered |
| --- | --- | --- |
| No gravity | 0.03°–0.18° | all |
| Gravity, correct (±1°) | identical to within 0.003° | all |
| Gravity on half the frames | identical | all |
| Gravity wrong by 30° | — | **5–14 of 30** |

On these scenes the final bundle adjustment reaches the same optimum either
way; a wrong prior, which is what a sign or axis mistake on a real phone would
produce, collapses registration. Without real captures to show a gain, the
mapper is not given gravity. The diagnostics below are what will tell.

### Where gravity does help: placing the scene

`georeference` (`sfm.py:455`) levelled the model by the MEAN CAMERA UP
(:480, :488): it assumes the phones were held level. A contributor pointing the
phone down at the street by 15° tilts the whole scene by 15° — 60 m of
street then climbs about 15 m, and the GPS fit sees a street foreshortened by
cos 15°. Measured with the walk in
`packages/reconstruction-worker/tests/test_motion_priors.py` (60 m, phone
pitched down 5°, 15° and 25°, 1° of noise on each gravity measurement): the
camera estimate tilts the placed scene by 4.9°, 14.9° and 24.9°, the measured
gravity by under 0.1°.

## What Expo delivers without a native module

`expo-sensors` (`~57.0.3`, Expo's own) `DeviceMotion`:

- iOS: Core Motion device motion (`DeviceMotionModule.swift`). Reading it needs
  **no permission**. `accelerationIncludingGravity − acceleration` is exactly
  `CMDeviceMotion.gravity × g`, the fused, low-noise gravity vector.
- Android: the fused sensors (`DeviceMotionModule.kt`);
  `accelerationIncludingGravity − acceleration` is `−TYPE_GRAVITY`, the same
  sign as iOS (pointing down), up to the few milliseconds between the latest
  accelerometer and linear-acceleration events.
- `rotation` (attitude) is also there, but its yaw reference differs by
  platform (magnetic north on iOS when available, the rotation-vector sensor on
  Android) and is a compass heading in all but name. It is not used.
- `DeviceMotion.requestPermissionsAsync()` asks for the PEDOMETER (iOS Motion
  & Fitness, Android `ACTIVITY_RECOGNITION`). GoWay never calls it.
- Web: `devicemotion` with engine-specific signs, a permission prompt on iOS
  Safari and no sensor on a desktop. Not used; the web recorder sends no motion.

What it cannot deliver: position, or a rotation that does not drift in yaw.
That is visual-inertial odometry, and it needs ARKit/ARCore.

## What was implemented

```text
GuidedCapture.native  ──motion {orientation, samples[t, gravity]}──▶ POST /captures/sessions/:id/assets
   (expo-sensors, from Start to stop)                                   │ capture_motion_tracks (temporary)
                                                                        ▼
privacy worker ──PrivacyFrame.timestampSeconds──▶ backend applyPrivacyResult ── street3d/motion.ts
                                                     │  gravity at each keyframe's instant, camera axes
                                                     ▼
                                     capture_derivatives.gravity_x|y|z ──▶ manifest InputFrame.gravity
                                                                                 │
                                                       worker sfm.georeference ◀─┘ (level from gravity)
```

- **Capture** (`features/contribute/guided/motion.ts`, `motionSensor.ts`).
  When the contributor taps Start, DeviceMotion is read at 20 Hz; each reading's
  gravity is checked (within 20 % of 1 g) and averaged into quarter-second
  samples, timed from the moment the recorder is started. Stopping the
  recorder stops the sensor. The recording orientation is the camera's last
  reported one on iOS and the natural orientation on Android.
- **Contract** (`packages/contracts/src/capture.ts`). `captureAssetInputSchema`
  gains optional `motion: { orientation, samples: [{ t, gravity: [x, y, z] }] }`:
  device axes, unit vectors (±0.01), strictly increasing `t`, at most
  `MAX_CAPTURE_MOTION_SAMPLES` = 14 400 (an hour at 4 Hz; about 0.73 MB of
  JSON at the app's rounding, inside the API's 1 MB body limit). Refused on a 360° capture: the phone
  that uploads one is not the camera that took it. Nothing about motion is
  ever in a response.
- **Storage** (migration `0018_goway_capture_motion`, `pre`).
  `capture_motion_tracks` holds the track as parallel `double precision[]`
  columns (equal lengths, bounded by CHECK). It is deleted when the privacy
  result consumes it, when the contributor withdraws or moderation blocks the
  capture (`discardMotionTrack`, last in both), and in the transaction that commits
  the raw object's deletion for any reason (`claimCaptureCleanup`). Every
  transaction that deletes a track takes its locks in one order — job, media
  object, asset, track — so a withdrawal overlapping a privacy completion
  waits instead of deadlocking. A failed
  privacy attempt keeps it for the next one.
- **Per frame** (`backend/src/street3d/motion.ts`). For each derivative, the
  track is interpolated at the keyframe's `timestampSeconds` (a photo is
  `t = 0`; a video keyframe reported without one gets none), nothing across a gap of more than 2 s or more than 1 s past either
  end, then rotated from device axes into the picture's camera axes by the
  recording orientation. A capture whose frames are the wrong shape for its
  orientation (a portrait track with landscape frames) gets no gravity at all:
  that is a mapping this code would get wrong, and no prior is safe where a
  wrong one is not. Stored as `capture_derivatives.gravity_x|y|z` (all or none,
  unit length by CHECK).
- **Worker contract.** The manifest's `InputFrame.gravity` (pydantic and zod,
  both validating a finite unit vector) and three optional result metrics:
  `gravityFrames`, `gravityLeveledFrames`, `medianGravityResidualDegrees`.
- **Solve** (`recon/sfm.py`, `level`). Each registered frame's measured gravity
  is rotated into the model by its solved rotation. Where at least 3 frames
  carry one, at least 60 % agree within 10° of their consensus, and the
  consensus is within 45° of the cameras' own mean up, the consensus IS down;
  otherwise the old camera-up estimate is kept. The 45° bound admits any
  realistic pitch and roll and refuses a measurement in the wrong axes (a 90°
  turn, or upside down), which would otherwise lay the street on its side. The
  median angle between the measurements and the chosen down is reported either
  way: on real captures it says how accurate the phones' gravity is once the
  solve has seen the images, which is the evidence needed before trusting it
  inside the mapper.

### Compatibility

Every addition is optional, so `schemaVersion` stays 1, as the contract's
policy for additive fields says. A manifest written before this change parses
on both sides (`contract/fixtures/scene_input_manifest.pre-gravity.json`, the
previous fixture verbatim); a result from an older worker has no gravity
metrics; a resumed solve whose checkpoint predates the change reports none.
An app build without the change sends no `motion`, and every capture so far is
in that state.

## Privacy

- Gravity's direction is not a location and says nothing about where the
  phone is or which way it faces: no coordinate, no compass heading, no
  acceleration and no rotation rate leave the device.
- No permission is requested, at launch or at Start. Sampling runs only while
  the contributor records.
- The track is temporary capture data, kept no longer than the raw media it
  describes and usually much less; per-frame gravity lives on the derivative
  rows, which are temporary themselves.
- It is never published: not in a capture response, not in a scene manifest,
  not in a log. The worker's gravity is a pydantic field of an internal
  manifest; the public SDK sees only the request shape, which describes the
  phone, not COLMAP.

## Open risks

- **Nothing here was run on a phone.** The sign of `expo-sensors` gravity on
  each platform, the recorded orientation on iOS and Android, and the time
  offset between the sensor clock's zero and the video's first frame are read
  from `expo-sensors` 57.0.3 and `expo-camera` 57.0.6 sources, not observed.
  The worker refuses a gravity that disagrees with the cameras by more than 45°
  and the backend drops a capture whose frames contradict the orientation, so
  a mistake costs the prior, not the scene. The first real captures' log line
  (`leveled by …: N frames carry gravity, median residual X°`) and result
  metrics are the check.
- **Time offset.** Samples are timed from just before `recordAsync`, which
  starts the file a little later. A walking phone's gravity changes slowly, so
  a few hundred milliseconds cost about a degree; it is not corrected.
- **Android tablets** whose natural orientation is landscape record landscape
  pictures under the `portrait` label and get no gravity (the shape check).
- **Library photos and system-camera shots carry none.** The app is not
  running its own code at the shutter; see the follow-ups.
- **`expo-sensors` brings native declarations GoWay does not use**, handled
  in `packages/frontend/app.config.js` because they follow from GoWay's own
  dependency and features, not from anything every Oxy app shares:
  - Android: the library manifest (`android/src/main/AndroidManifest.xml`, and
    the prebuilt `expo.modules.sensors-57.0.3.aar` Gradle actually merges)
    declares `ACTIVITY_RECOGNITION` for the Pedometer. `android.blockedPermissions`
    removes it; measured with `processDebugMainManifest` on a scratch prebuild,
    the merged manifest lost that permission and nothing else. Guarded by
    `packages/frontend/__tests__/nativePermissions.test.ts`.
  - iOS: the plugin is auto-applied even when unlisted and writes a generic
    `NSMotionUsageDescription`. The key is KEPT with GoWay's own wording, not
    removed with `motionPermission: false`: device motion asks for nothing, but
    the precompiled `ExpoSensors` binary (the SDK 57 default) still links
    `CMPedometer`/`CMAltimeter`, so an upload without the string risks
    `ITMS-90683`, and that binary's `getPermissionsAsync()` calls `RCTFatal`
    when the key is missing (`EXPO_DISABLE_MOTION_PERMISSION` only reaches a
    source build). No prompt is ever shown: GoWay calls no motion permission
    API.

## Follow-ups

1. **Gravity in the mapper.** Once real captures report residuals of a few
   degrees, write `PosePrior.gravity` into the database before
   `global_mapping` and set `rotation_averaging.use_gravity` (with
   `use_stratified`, since library media has none), solving again without it
   when registration drops. The synthetic test above is the regression guard.
2. **Upright frames.** An Android recording held sideways is stored sideways.
   `compute_rot90_from_gravity` says how to turn each keyframe upright before
   detection and matching; that is a privacy-job change.
3. **In-app stills.** Shooting photos through `CameraView.takePictureAsync`
   instead of the system camera would give each photo its gravity at `t = 0`
   through exactly this path.

### Follow-up: visual-inertial poses

What GroundedSLAM-style capture needs is ARKit (`ARWorldTrackingConfiguration`)
or ARCore world-tracking poses per frame: metric, gravity-aligned, locally
drift-free position and rotation, computed on the device with no cloud service
(ARCore's Cloud Anchors and Geospatial API send imagery to Google and stay out).

- **Native module, both platforms.** ARKit owns the camera while it tracks, so
  the guided recorder would have to encode `ARFrame.capturedImage` itself
  (`AVAssetWriter`) instead of using `expo-camera`; on Android, ARCore's
  shared-camera mode with a `MediaCodec` encoder, on ARCore-supported devices
  only. Each frame's pose and tracking state is written beside the video.
- **Native config**, through `@oxy.so/app-preset`: the ARCore dependency and its
  `com.google.ar.core` manifest metadata (optional, so unsupported phones keep
  the plain recorder), and the iOS camera usage string it already has.
- **Contract:** per-sample camera pose in a local metric frame (rotation and
  translation, tracking quality), replacing or extending `motion`; same
  temporary storage and lifetime.
- **Worker:** positions as `PosePrior` (`CARTESIAN`, with covariance) through
  `use_prior_position` or `create_pose_prior_bundle_adjuster`, gravity as
  above, and rotations only through a hand-built `pyceres` problem with
  `AbsolutePosePriorCost`/`RelativePosePriorCost`; metric scale from the device
  instead of GPS.
- **Cost:** two native modules, a recorder rewrite on each platform, a config
  plugin, a contract version and worker BA work — weeks, not days, plus a device
  test matrix. Gravity alone, shipped here, needed none of it.
