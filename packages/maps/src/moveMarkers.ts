/**
 * The marks a camera COMMAND carries, so the map reports the camera it
 * produces as the app's move and never as the reader's. Every command
 * `@goway.to/maps` issues is marked; an engine plugin that moves the camera
 * itself passes {@link PROGRAMMATIC} as the command's event data
 * (`map.easeTo(options, PROGRAMMATIC)`).
 */
/**
 * Marker put on every camera COMMAND the map issues, read back off the event.
 *
 * Marking our own commands (rather than sniffing for a DOM `originalEvent`) is
 * the safer direction of failure: a command somebody forgets to mark reads as a
 * user gesture, so "Search this area" appears once when it need not have. The
 * alternative — treat anything unrecognised as programmatic — hides the button
 * for good and looks like the feature was never built.
 */
export const PROGRAMMATIC = { gowayProgrammatic: true } as const;

/**
 * One frame of a caller-driven animation (`MapCameraOptions.transient`): a
 * programmatic move whose `moveend` is not a settled camera.
 */
export const PROGRAMMATIC_TRANSIENT = { gowayProgrammatic: true, gowayTransient: true } as const;
