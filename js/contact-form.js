// Contact Form — posts to backend /api/contact per M2-04 D-09.
// Portal ID and form GUID live server-side now (api/contact-route.js).
(function () {
    'use strict';

    var MAX_FIELD_LENGTH = 500;
    var MAX_MESSAGE_LENGTH = 5000;
    var SUBMIT_COOLDOWN_MS = 5000;
    var lastSubmitTime = 0;

    function sanitize(str, maxLen) {
        if (!str) return '';
        return str.trim().slice(0, maxLen || MAX_FIELD_LENGTH);
    }

    function isEN() {
        return window.location.search.indexOf('lang=en') !== -1 ||
               window.location.pathname.indexOf('-en') !== -1;
    }

    function getPageName() {
        var path = window.location.pathname.replace(/^\//, '').replace(/\.html$/, '');
        return path || 'homepage';
    }

    function splitName(fullName) {
        var parts = fullName.trim().split(/\s+/);
        return {
            first: parts[0] || '',
            last: parts.slice(1).join(' ') || ''
        };
    }

    function setButtonState(btn, state, en) {
        if (!btn) return;
        switch (state) {
            case 'loading':
                btn.disabled = true;
                btn.dataset.originalText = btn.textContent;
                btn.textContent = en ? 'Sending...' : 'Verzenden...';
                break;
            case 'success':
                btn.disabled = true;
                btn.textContent = en ? 'Message sent!' : 'Bericht verzonden!';
                btn.style.background = '#28a745';
                btn.style.color = '#fff';
                // Success message or redirect
                alert(en ? 'Thank you! We will contact you soon.' : 'Bedankt! We nemen snel contact met u op.');
                setTimeout(function () {
                    btn.textContent = btn.dataset.originalText || (en ? 'SEND MESSAGE' : 'VERSTUUR BERICHT');
                    btn.style.background = '';
                    btn.style.color = '';
                    btn.disabled = false;
                }, 4000);
                break;
            case 'error':
                btn.disabled = false;
                btn.textContent = en ? 'Error — try again' : 'Fout — probeer opnieuw';
                btn.style.background = '#d23234';
                btn.style.color = '#fff';
                setTimeout(function () {
                    btn.textContent = btn.dataset.originalText || (en ? 'SEND MESSAGE' : 'VERSTUUR BERICHT');
                    btn.style.background = '';
                    btn.style.color = '';
                }, 4000);
                break;
        }
    }

    window.sendContactEmail = function (e) {
        e.preventDefault();
        var form = e.target;
        var en = isEN();
        var btn = form.querySelector('button[type="submit"]');

        // Honeypot check — bot filled the hidden field
        var hp = form.querySelector('input[name="website_url"]');
        if (hp && hp.value) {
            setButtonState(btn, 'success', en);
            form.reset();
            return;
        }

        // Rate limiting
        var now = Date.now();
        if (now - lastSubmitTime < SUBMIT_COOLDOWN_MS) {
            return;
        }
        lastSubmitTime = now;

        // Collect and sanitize
        var nameEl = form.querySelector('input[name="firstname"]');
        var emailEl = form.querySelector('input[name="email"]');
        var companyEl = form.querySelector('input[name="company"]');
        var messageEl = form.querySelector('textarea[name="message"]');
        var consentEl = form.querySelector('input[name="privacy_consent"]');

        var fullName = sanitize(nameEl ? nameEl.value : '', MAX_FIELD_LENGTH);
        var email = sanitize(emailEl ? emailEl.value : '', MAX_FIELD_LENGTH);
        var company = sanitize(companyEl ? companyEl.value : '', MAX_FIELD_LENGTH);
        var message = sanitize(messageEl ? messageEl.value : '', MAX_MESSAGE_LENGTH);

        // Validation
        if (!fullName || !email) {
            return;
        }
        var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return;
        }
        if (consentEl && !consentEl.checked) {
            return;
        }

        var nameParts = splitName(fullName);

        setButtonState(btn, 'loading', en);

        // 1. Push to HubSpot via tracking code (_hsq)
        var _hsq = window._hsq = window._hsq || [];
        _hsq.push(['identify', {
            email: email,
            firstname: nameParts.first,
            lastname: nameParts.last,
            company: company
        }]);
        _hsq.push(['trackPageView']);

        // 2. Submit via HubSpot's collected forms endpoint
        // 3. Fallback: mailto if HubSpot fail (simplified for static)
        submitToHubSpot({
            email: email,
            firstname: nameParts.first,
            lastname: nameParts.last,
            company: company,
            message: message,
            page: getPageName(),
            language: en ? 'en' : 'nl',
            consent: consentEl ? consentEl.checked : false
        }, function (success) {
            if (success) {
                setButtonState(btn, 'success', en);
                form.reset();
            } else {
                // Final fallback: open mailto
                const body = `Naam: ${fullName}%0AEmail: ${email}%0ABedrijf: ${company}%0A%0ABericht:%0A${message}`;
                window.location.href = `mailto:klantcontact@interactivemove.nl?subject=Contact via website (${getPageName()})&body=${body}`;
                setButtonState(btn, 'success', en);
                form.reset();
            }
        });
    };

    function submitToHubSpot(data, callback) {
        // Posts to same-origin /api/contact; backend forwards to HubSpot v3 server-to-server.
        var payload = {
            firstname: data.firstname,
            lastname:  data.lastname,
            email:     data.email,
            company:   data.company,
            message:   data.message,
            consent:   !!data.consent,
            pageUri:   window.location.href,
            pageName:  document.title,
            language:  data.language || (isEN() ? 'en' : 'nl'),
            // Honeypot — must stay empty; bots fill it. Backend silently 200s if non-empty.
            website_url: ''
        };
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/contact', true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.timeout = 10000;
            xhr.onload = function () {
                var ok = false;
                try { ok = JSON.parse(xhr.responseText || '{}').ok === true; } catch (_) {}
                callback(ok && xhr.status >= 200 && xhr.status < 300);
            };
            xhr.onerror = function () { callback(false); };
            xhr.ontimeout = function () { callback(false); };
            xhr.send(JSON.stringify(payload));
        } catch (err) {
            callback(false);
        }
    }

    function getCookie(name) {
        var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
        return match ? match[2] : '';
    }

    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }
})();
