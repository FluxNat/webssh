/*
 * PixShell motion: small progressive enhancements that CSS cannot do alone.
 *
 * - a sliding indicator under the active primary navigation item
 * - a soft ripple where a button is pressed
 * - a pointer-following glow on interactive cards
 *
 * Everything is decorative: no state lives here, and the page works the same
 * without it. All effects are skipped when the user prefers reduced motion.
 */
(function () {
    'use strict';

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const RIPPLE_SELECTOR = '.btn, .global-nav-item, .tab-row-icon-btn, .split-btn, .tab-row-share-btn, .context-workspace-launcher';
    const GLOW_SELECTOR = [
        '.profile-launcher-card',
        '.settings-context-card',
        '.admin-settings-surface',
        '.quick-connect-card',
        '.manager-card',
        '.credential-switch',
    ].join(', ');

    function setupNavigationIndicator() {
        const navigation = document.getElementById('globalNavigation');
        if (!navigation) return;
        const indicator = document.createElement('span');
        indicator.className = 'global-nav-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        navigation.appendChild(indicator);

        let frame = 0;
        const place = () => {
            frame = 0;
            const active = navigation.querySelector('.global-nav-item.active');
            const visible = active
                && navigation.offsetParent !== null
                && getComputedStyle(navigation).flexDirection === 'row';
            navigation.classList.toggle('has-indicator', Boolean(visible));
            if (!visible) return;
            const bounds = navigation.getBoundingClientRect();
            const item = active.getBoundingClientRect();
            indicator.style.setProperty('--px-indicator-x', `${item.left - bounds.left}px`);
            indicator.style.setProperty('--px-indicator-w', `${item.width}px`);
        };
        const schedule = () => {
            if (!frame) frame = window.requestAnimationFrame(place);
        };

        new MutationObserver(schedule).observe(navigation, {
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
        });
        window.addEventListener('resize', schedule);
        window.addEventListener('languageChanged', schedule);
        document.fonts?.ready?.then(schedule);
        schedule();
    }

    function ripple(event) {
        if (reducedMotion.matches || event.button !== 0) return;
        const target = event.target.closest?.(RIPPLE_SELECTOR);
        if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;

        const bounds = target.getBoundingClientRect();
        const size = Math.max(bounds.width, bounds.height) * 2;
        let host = target.querySelector(':scope > .px-ripple-host');
        if (!host) {
            host = document.createElement('span');
            host.className = 'px-ripple-host';
            host.setAttribute('aria-hidden', 'true');
            target.appendChild(host);
        }
        const wave = document.createElement('span');
        wave.className = 'px-ripple';
        wave.style.setProperty('--px-ripple-size', `${size}px`);
        wave.style.setProperty('--px-ripple-x', `${event.clientX - bounds.left - size / 2}px`);
        wave.style.setProperty('--px-ripple-y', `${event.clientY - bounds.top - size / 2}px`);
        host.appendChild(wave);
        wave.addEventListener('animationend', () => wave.remove(), { once: true });
    }

    let glowFrame = 0;
    let glowEvent = null;
    function glow(event) {
        if (reducedMotion.matches || event.pointerType === 'touch') return;
        glowEvent = event;
        if (glowFrame) return;
        glowFrame = window.requestAnimationFrame(() => {
            glowFrame = 0;
            const card = glowEvent.target.closest?.(GLOW_SELECTOR);
            if (!card) return;
            const bounds = card.getBoundingClientRect();
            card.style.setProperty('--px-glow-x', `${glowEvent.clientX - bounds.left}px`);
            card.style.setProperty('--px-glow-y', `${glowEvent.clientY - bounds.top}px`);
        });
    }

    function init() {
        document.documentElement.classList.add('px-motion-ready');
        setupNavigationIndicator();
        document.addEventListener('pointerdown', ripple, { passive: true });
        document.addEventListener('pointermove', glow, { passive: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
}());
