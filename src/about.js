import { openModal, closeModal } from './modal.js';

export function openAbout() {
    openModal('about-modal');
}

export function closeAbout() {
    closeModal('about-modal');
}

export function openPrivacy() {
    openModal('privacy-modal');
}

export function closePrivacy() {
    closeModal('privacy-modal');
}
