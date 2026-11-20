/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/*
 * Tooltips for the title attribute, drawn by the page.
 *
 * On macOS the native tooltips of title attributes do not show up in the Talk window, while on
 * Windows and Linux they do. Talk relies on them for every icon button (the call controls have
 * no text), so they are drawn here instead: one element in <body>, shown for whatever element
 * with a title is under the pointer or has the keyboard focus. Nothing in Talk needs changing.
 *
 * While its tooltip is shown, the element's title moves to data-title, so that a native tooltip
 * never shows on top of it, and comes back when the tooltip hides.
 */

const SHOW_DELAY = 500
const GAP = 6
const MARGIN = 8

let tooltip: HTMLElement | null = null
let target: HTMLElement | null = null
// Whether the tooltip of target is shown: its title is in data-title only then
let shown = false
let showTimer: number | undefined

/**
 * The closest element with a non-empty title
 *
 * @param node - Where the event happened
 */
function findTarget(node: EventTarget | null): HTMLElement | null {
	const element = node instanceof Element ? node.closest<HTMLElement>('[title]:not([title=""])') : null
	return element && element !== document.documentElement && element !== document.body ? element : null
}

/**
 * The tooltip element, created on first use
 */
function getTooltip() {
	if (!tooltip) {
		tooltip = document.createElement('div')
		tooltip.className = 'title-tooltip'
		tooltip.setAttribute('role', 'tooltip')
		tooltip.setAttribute('aria-hidden', 'true')
	}
	// In full screen only the full-screen element and its children are shown
	const host = document.fullscreenElement ?? document.body
	if (tooltip.parentElement !== host) {
		host.appendChild(tooltip)
	}
	return tooltip
}

/**
 * Hide the tooltip and give the title back to its element
 */
function hide() {
	clearTimeout(showTimer)
	if (shown && target?.dataset.title !== undefined) {
		// Talk may have changed the title meanwhile: it went to data-title, see the observer
		target.setAttribute('title', target.dataset.title)
		delete target.dataset.title
	}
	target = null
	shown = false
	tooltip?.classList.remove('title-tooltip--visible')
}

/**
 * Show the tooltip of an element: above it, or below when there is no room above
 *
 * @param element - The element with a title
 */
function show(element: HTMLElement) {
	const text = element.getAttribute('title')
	if (!text || !element.isConnected) {
		return
	}
	element.dataset.title = text
	element.removeAttribute('title')
	shown = true

	const tip = getTooltip()
	tip.textContent = text
	tip.classList.add('title-tooltip--visible')

	const rect = element.getBoundingClientRect()
	const { width, height } = tip.getBoundingClientRect()
	const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, MARGIN), window.innerWidth - width - MARGIN)
	const above = rect.top - GAP - height
	const top = above >= MARGIN ? above : rect.bottom + GAP
	tip.style.left = `${Math.round(left)}px`
	tip.style.top = `${Math.round(top)}px`
}

/**
 * Schedule the tooltip of an element
 *
 * @param element - The element with a title, or null
 * @param delay - Before showing
 */
function scheduleFor(element: HTMLElement | null, delay: number) {
	if (element === target) {
		return
	}
	hide()
	if (!element) {
		return
	}
	target = element
	showTimer = window.setTimeout(() => target === element && show(element), delay)
}

/**
 * Draw the tooltips of title attributes on macOS
 */
export function setupTitleTooltips() {
	if (!window.systemInfo.isMac) {
		return
	}

	document.addEventListener('pointerover', (event) => {
		if (event.pointerType === 'mouse') {
			scheduleFor(findTarget(event.target), SHOW_DELAY)
		}
	}, { passive: true })
	document.addEventListener('pointerout', (event) => {
		if (target && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) {
			hide()
		}
	}, { passive: true })
	// Keyboard users get the tooltip of the focused element, as with the native ones on hover
	document.addEventListener('focusin', (event) => {
		if (event.target instanceof HTMLElement && event.target.matches(':focus-visible')) {
			scheduleFor(findTarget(event.target), SHOW_DELAY)
		}
	})
	document.addEventListener('focusout', hide)
	// A click usually changes what the element does; a key press, a scroll or a leaving pointer
	// make the tooltip stale
	document.addEventListener('pointerdown', hide, { capture: true, passive: true })
	document.addEventListener('keydown', (event) => event.key === 'Escape' && hide(), { capture: true })
	document.addEventListener('scroll', hide, { capture: true, passive: true })
	document.addEventListener('fullscreenchange', hide)
	window.addEventListener('blur', hide)

	// The element of a shown tooltip may change its title (a toggle button) or disappear
	new MutationObserver(() => {
		if (!target) {
			return
		}
		if (!target.isConnected) {
			hide()
			return
		}
		const title = target.getAttribute('title')
		// Talk set a new title while ours was moved away: show and keep the new one
		if (shown && title) {
			target.dataset.title = title
			target.removeAttribute('title')
			if (tooltip) {
				tooltip.textContent = title
			}
		}
	}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] })
}
