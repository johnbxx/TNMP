/**
 * Shared modal helpers: open/close, focus trapping, Escape/backdrop/button dismiss.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const previousFocus = new Map();
const closeHooks = {};

/**
 * Register a cleanup hook called when a modal is closed.
 * @param {string} modalId
 * @param {Function} fn
 */
export function onModalClose(modalId, fn) {
    closeHooks[modalId] = fn;
}

/**
 * Open a modal by ID with proper focus management.
 * @param {string} modalId
 * @param {HTMLElement} [focusTarget] - Element to focus (defaults to first focusable)
 */
export function openModal(modalId, focusTarget) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    previousFocus.set(modalId, document.activeElement);
    modal.classList.remove('hidden', 'closing');
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
    document.body.style.top = `-${window.scrollY}px`;

    const container = document.querySelector('.container');
    if (container) container.setAttribute('aria-hidden', 'true');

    const target = focusTarget || modal.querySelector(FOCUSABLE);
    if (target) {
        requestAnimationFrame(() => target.focus());
    }
}

/**
 * Close a modal by ID, run its close hook, and restore focus.
 * @param {string} modalId
 */
export function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal || modal.classList.contains('hidden')) return;

    // Play closing animation, then hide
    modal.classList.add('closing');
    let done = false;
    const onDone = () => {
        if (done) return;
        done = true;
        modal.classList.remove('closing');
        modal.classList.add('hidden');

        const hook = closeHooks[modalId];
        if (hook) hook();

        const anyOpen = document.querySelector('.modal:not(.hidden)');
        if (!anyOpen) {
            const scrollY = Math.abs(parseInt(document.body.style.top || '0', 10));
            document.body.style.overflow = '';
            document.body.style.position = '';
            document.body.style.width = '';
            document.body.style.top = '';
            window.scrollTo(0, scrollY);
            const container = document.querySelector('.container');
            if (container) container.removeAttribute('aria-hidden');
        }

        const prev = previousFocus.get(modalId);
        if (prev && typeof prev.focus === 'function') {
            prev.focus();
        }
        previousFocus.delete(modalId);
    };

    // Listen for close animation end on content element
    const content = modal.querySelector('.modal-content, .modal-content-viewer');
    if (content) {
        content.addEventListener('animationend', () => onDone(), { once: true });
    }
    setTimeout(onDone, 200); // safety fallback
}

/**
 * Trap focus within a modal when Tab is pressed.
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

// --- Generic click delegation ---

// Backdrop click → close the parent modal
// data-close-modal button → close the parent modal
// data-open-modal="id" button → open that modal
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) {
        const modal = e.target.closest('.modal');
        if (modal && !modal.hasAttribute('data-manual-close')) closeModal(modal.id);
        return;
    }

    const closeBtn = e.target.closest('[data-close-modal]');
    if (closeBtn) {
        const modal = closeBtn.closest('.modal');
        if (modal) closeModal(modal.id);
        return;
    }

    const openBtn = e.target.closest('[data-open-modal]');
    if (openBtn) {
        openModal(openBtn.dataset.openModal);
        return;
    }

    const switchBtn = e.target.closest('[data-switch-modal]');
    if (switchBtn) {
        e.preventDefault();
        const current = switchBtn.closest('.modal');
        if (current) closeModal(current.id);
        setTimeout(() => openModal(switchBtn.dataset.switchModal), 300);
    }
});

// Escape key → close the topmost visible modal
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modals = document.querySelectorAll('.modal:not(.hidden)');
    if (modals.length === 0) return;
    const topModal = modals[modals.length - 1];
    if (topModal.hasAttribute('data-manual-close')) return;
    closeModal(topModal.id);
});
