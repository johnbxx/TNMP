/**
 * Shared modal helpers: open/close, focus trapping, Escape/backdrop/button dismiss.
 */

const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const previousFocus = new Map();
const closeHooks = {};

export function onModalClose(modalId, fn) {
    closeHooks[modalId] = fn;
}

export function openModal(modalId, focusTarget) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    previousFocus.set(modalId, document.activeElement);
    modal.classList.remove('hidden', 'closing');
    document.body.style.overflow = 'hidden';

    const container = document.querySelector('.container');
    if (container) container.setAttribute('aria-hidden', 'true');

    const target = focusTarget || modal.querySelector(FOCUSABLE);
    if (target) {
        requestAnimationFrame(() => target.focus());
    }
}

export function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal || modal.classList.contains('hidden')) return;

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
            document.body.style.overflow = '';
            const container = document.querySelector('.container');
            if (container) container.removeAttribute('aria-hidden');
        }

        const prev = previousFocus.get(modalId);
        if (prev && typeof prev.focus === 'function') {
            prev.focus();
        }
        previousFocus.delete(modalId);
    };

    const content = modal.querySelector('.modal-content, .modal-content-viewer');
    if (content) {
        content.addEventListener('animationend', () => onDone(), { once: true });
    }
    setTimeout(onDone, 200); // safety fallback
}

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

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modals = document.querySelectorAll('.modal:not(.hidden)');
    if (modals.length === 0) return;
    const topModal = modals[modals.length - 1];
    if (topModal.hasAttribute('data-manual-close')) return;
    closeModal(topModal.id);
});
