/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { app } from 'electron'
import { appendFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_SIZE = 1024 * 1024

let queue = Promise.resolve()

/**
 * Append a line to remote-control.log in the app's log directory, rotating it at 1 MB.
 * Records grants, revokes, refused checks and clipboard sizes - never keys or clipboard
 * content, which contain passwords.
 *
 * @param event - What happened
 * @param details - Plain data to record with it
 */
export function rcLog(event: string, details: Record<string, unknown> = {}) {
	const line = JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n'
	console.info('[remote-control]', event, details)
	queue = queue.then(async () => {
		const path = join(app.getPath('logs'), 'remote-control.log')
		try {
			if ((await stat(path)).size > MAX_SIZE) {
				await rename(path, path + '.1')
			}
		} catch {
			// No log yet
		}
		await appendFile(path, line)
	}).catch((error) => console.error('[remote-control] Failed to write the log:', error))
}
