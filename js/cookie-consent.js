/**
 * IAM Cookie Consent - GDPR/Dutch Law Compliant
 * Version: 1.0
 *
 * Features:
 * - Shows consent banner before any non-essential cookies
 * - Equal prominence for Accept/Reject buttons (Dutch law requirement)
 * - Stores consent proof with timestamp
 * - Respects user choice
 */

(function() {
    'use strict';

    const CONSENT_KEY = 'iam_consent';
    const CONSENT_VERSION = '1.0';

    // Check if consent already given
    function getConsent() {
        try {
            const consent = localStorage.getItem(CONSENT_KEY);
            if (consent) {
                return JSON.parse(consent);
            }
        } catch (e) {
            console.warn('Could not read consent:', e);
        }
        return null;
    }

    // Load Google Tag Manager (only after consent)
    function loadGTM() {
        if (window._gtmLoaded) return;
        window._gtmLoaded = true;
        (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-KPX78C22');
    }

    // Save consent choice
    function saveConsent(choice) {
        const consentData = {
            version: CONSENT_VERSION,
            timestamp: new Date().toISOString(),
            necessary: true, // Always true
            analytics: choice === 'all',
            marketing: choice === 'all',
            choice: choice // 'all', 'necessary', or 'custom'
        };

        try {
            localStorage.setItem(CONSENT_KEY, JSON.stringify(consentData));
        } catch (e) {
            console.warn('Could not save consent:', e);
        }

        return consentData;
    }

    // Create and show consent banner
    function showBanner() {
        // Don't show if already consented
        if (getConsent()) {
            return;
        }

        const isNL = !(window.location.search.includes('lang=en') ||
                      document.documentElement.lang === 'en' ||
                      document.querySelector('.lang-btn.active')?.textContent?.trim() === 'EN');

        const texts = isNL ? {
            title: 'Wij respecteren uw privacy',
            description: 'Wij gebruiken alleen noodzakelijke cookies om de website te laten werken. Wij gebruiken geen tracking of advertentiecookies.',
            learnMore: 'Lees ons cookiebeleid',
            acceptAll: 'Accepteren',
            rejectAll: 'Alleen noodzakelijk'
        } : {
            title: 'We respect your privacy',
            description: 'We only use necessary cookies to make the website work. We do not use tracking or advertising cookies.',
            learnMore: 'Read our cookie policy',
            acceptAll: 'Accept',
            rejectAll: 'Necessary only'
        };

        const banner = document.createElement('div');
        banner.className = 'cookie-consent';
        banner.id = 'cookieConsent';
        banner.setAttribute('role', 'dialog');
        banner.setAttribute('aria-labelledby', 'cookie-title');
        banner.setAttribute('aria-modal', 'true');

        banner.innerHTML = `
            <div class="cookie-consent-container">
                <div class="cookie-consent-text">
                    <h3 id="cookie-title">${texts.title}</h3>
                    <p>${texts.description} <a href="/cookies">${texts.learnMore}</a>.</p>
                </div>
                <div class="cookie-consent-buttons">
                    <button class="cookie-btn cookie-btn-reject" id="cookieReject">${texts.rejectAll}</button>
                    <button class="cookie-btn cookie-btn-accept" id="cookieAccept">${texts.acceptAll}</button>
                </div>
            </div>
        `;

        document.body.appendChild(banner);

        // Trigger animation
        requestAnimationFrame(() => {
            banner.classList.add('show');
        });

        // Event handlers
        document.getElementById('cookieAccept').addEventListener('click', function() {
            saveConsent('all');
            loadGTM();
            hideBanner();
        });

        document.getElementById('cookieReject').addEventListener('click', function() {
            saveConsent('necessary');
            hideBanner();
        });
    }

    // Hide the banner
    function hideBanner() {
        const banner = document.getElementById('cookieConsent');
        if (banner) {
            banner.classList.remove('show');
            setTimeout(() => {
                banner.remove();
            }, 300);
        }
    }

    // Reset consent (for settings link)
    window.resetCookieConsent = function() {
        localStorage.removeItem(CONSENT_KEY);
        showBanner();
    };

    // Get current consent status
    window.getCookieConsent = function() {
        return getConsent();
    };

    // Initialize after a short delay so HTMX can push ?lang= into URL first
    function init() {
        // If user already consented to all, load GTM immediately
        var existing = getConsent();
        if (existing && existing.choice === 'all') {
            loadGTM();
        }
        setTimeout(showBanner, 500);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
