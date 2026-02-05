/**
 * Shared modal helpers: focus trapping, focus restoration, backdrop click.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Track which element had focus before the modal opened
const previousFocus = new Map();

/**
 * Open a modal by ID with proper focus management.
 * @param {string} modalId - The modal element ID
 * @param {HTMLElement} [focusTarget] - Element to focus inside the modal (defaults to first focusable)
 */
export function openModal(modalId, focusTarget) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    // Remember what had focus before opening
    previousFocus.set(modalId, document.activeElement);

    modal.classList.remove('hidden');

    // Focus the target or first focusable element
    const target = focusTarget || modal.querySelector(FOCUSABLE);
    if (target) {
        // Delay to ensure the modal is visible before focusing
        requestAnimationFrame(() => target.focus());
    }
}

/**
 * Close a modal by ID and restore focus to the previously focused element.
 * @param {string} modalId - The modal element ID
 */
export function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    modal.classList.add('hidden');

    // Restore focus
    const prev = previousFocus.get(modalId);
    if (prev && typeof prev.focus === 'function') {
        prev.focus();
    }
    previousFocus.delete(modalId);
}

/**
 * Trap focus within a modal when Tab is pressed.
 * Call this from the keydown handler when a modal is open.
 * @param {KeyboardEvent} e
 * @param {string} modalId
 */
export function trapFocus(e, modalId) {
    if (e.key !== 'Tab') return;

    const modal = document.getElementById(modalId);
    if (!modal) return;

    const focusable = modal.querySelectorAll(FOCUSABLE);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
        if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
        }
    } else {
        if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }
}

// --- Backdrop click handling ---
// Delegate click on .modal-backdrop to close the parent modal.
// Each modal's close function is registered here.
const closeHandlers = {};

export function registerModalClose(modalId, closeFn) {
    closeHandlers[modalId] = closeFn;
}

document.addEventListener('click', (e) => {
    if (!e.target.classList.contains('modal-backdrop')) return;
    const modal = e.target.closest('.modal');
    if (!modal) return;
    const handler = closeHandlers[modal.id];
    if (handler) handler();
});
