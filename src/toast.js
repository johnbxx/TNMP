/**
 * Show a toast notification at the top of the screen.
 * Reuses a single #app-toast element, creating it on first use.
 *
 * @param {string} message
 * @param {'success'|'error'|'info'} [type='info']
 */
export function showToast(message, type = 'info') {
    let toast = document.getElementById('app-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'app-toast';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.innerHTML = '<span class="toast-icon"></span><span class="toast-msg"></span>';
        document.body.appendChild(toast);

        // Click to dismiss
        toast.addEventListener('click', () => {
            clearTimeout(toast._hideTimer);
            toast.classList.remove('show');
        });

        // Pause on hover
        toast.addEventListener('mouseenter', () => clearTimeout(toast._hideTimer));
        toast.addEventListener('mouseleave', () => {
            if (toast.classList.contains('show')) {
                toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 1500);
            }
        });
    }
    const msgEl = toast.querySelector('.toast-msg');
    if (toast.classList.contains('show') && msgEl.textContent === message) {
        toast.classList.remove('toast-shake');
        requestAnimationFrame(() => toast.classList.add('toast-shake'));
    }
    toast.className = `toast toast-${type}`;
    msgEl.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}
