/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Legacy Chromium desktop-capture constraints used by Electron's getUserMedia path.
 */
type LegacyDesktopConstraints = {
	mandatory?: {
		chromeMediaSource?: string
		chromeMediaSourceId?: string
	}
}

/**
 * The custom sourceId used for capturing all the screens at once, see the screensharing dialog.
 */
const ENTIRE_DESKTOP_SOURCE_ID = 'entire-desktop:0:0'

/**
 * The sourceId of a whole-screen capture requested with the given constraints, or null if the
 * constraints are not a whole-screen capture.
 *
 * Only screens are indicated: Chromium already draws a border around a captured window itself,
 * and there the shared area is a window the user can see anyway.
 *
 * @param constraints - getUserMedia constraints
 */
function getScreenCaptureSourceId(constraints: MediaStreamConstraints): string | null {
	const video = constraints.video
	if (!video || typeof video === 'boolean') {
		return null
	}

	const mandatory = (video as unknown as LegacyDesktopConstraints).mandatory
	if (!mandatory || mandatory.chromeMediaSource !== 'desktop') {
		return null
	}

	// No sourceId → the entire desktop; "screen:" → a single monitor; "window:" → a single window
	const sourceId = mandatory.chromeMediaSourceId ?? ENTIRE_DESKTOP_SOURCE_ID
	return sourceId.startsWith('window:') ? null : sourceId
}

/**
 * The unwrapped getUserMedia, kept to be able to capture without lighting the indicator.
 */
let originalGetUserMedia: MediaDevices['getUserMedia'] | null = null

/**
 * Capture media without showing the screensharing indicator.
 *
 * For the live previews in the screensharing picker: they capture a screen to show what it
 * looks like, but nothing is shared with anyone yet, so a border on that screen would be a lie.
 *
 * @param constraints - getUserMedia constraints
 */
export function getUserMediaWithoutIndicator(constraints: MediaStreamConstraints): Promise<MediaStream> {
	const getUserMedia = originalGetUserMedia ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
	return getUserMedia(constraints)
}

/**
 * Paint a border along the edges of the shared screen while a screen is being shared.
 *
 * With the Talk window minimized nothing else on the screen says that sharing is still
 * running, and a forgotten screen share is how private content ends up in a call.
 *
 * Implemented by wrapping getUserMedia so that both the start (a screen capture is requested)
 * and the end (the capture track stops) are observed, without any change to Talk (spreed).
 */
export function setupScreenshareIndicator(): void {
	const mediaDevices = navigator.mediaDevices
	if (!mediaDevices?.getUserMedia) {
		return
	}

	// Reset to a known baseline: a freshly (re)loaded page shares nothing, so any indicator
	// left behind by a page reload during a share has to go.
	window.TALK_DESKTOP.setScreenshareIndicator(null)

	originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices)
	const getUserMedia = originalGetUserMedia

	mediaDevices.getUserMedia = async function(constraints?: MediaStreamConstraints): Promise<MediaStream> {
		const stream = await getUserMedia(constraints)

		const sourceId = constraints && getScreenCaptureSourceId(constraints)
		if (sourceId) {
			window.TALK_DESKTOP.setScreenshareIndicator(sourceId)

			let hidden = false
			const hideIndicator = () => {
				if (hidden) {
					return
				}
				hidden = true
				window.TALK_DESKTOP.setScreenshareIndicator(null)
			}

			for (const track of stream.getVideoTracks()) {
				// 'ended' covers the user stopping the share via the OS;
				// wrapping stop() covers Talk stopping the share programmatically.
				track.addEventListener('ended', hideIndicator, { once: true })
				const originalStop = track.stop.bind(track)
				track.stop = () => {
					originalStop()
					hideIndicator()
				}
			}
		}

		return stream
	}
}
