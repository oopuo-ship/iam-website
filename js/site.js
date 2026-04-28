// site.js — Unified JS for IAM website (nav, lang switching, reveals)

// === Mobile Navigation ===
function toggleMobileNav() {
    var nav = document.getElementById('mobileNav');
    if (nav) nav.classList.toggle('active');
}

function closeMobileNav() {
    var nav = document.getElementById('mobileNav');
    if (nav) nav.classList.remove('active');
}

function toggleMobileDropdown(btn) {
    if (btn && btn.parentElement) {
        btn.parentElement.classList.toggle('open');
    }
}

// === Language Switching ===
function switchLang(lang) {
    // 1. Save to localStorage
    localStorage.setItem('iam-lang', lang);

    // 2. Update URL param
    var url = new URL(window.location);
    url.searchParams.set('lang', lang);
    history.replaceState(null, '', url);

    // 3. Toggle active on lang buttons
    document.querySelectorAll('.lang-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
    });

    // 4. Set data-lang on <html>
    document.documentElement.setAttribute('data-lang', lang);

    // 5. Build partial path
    var body = document.body;
    var slug = body.getAttribute('data-page') || 'index';
    var basePath = body.getAttribute('data-base') || '';
    var section = body.getAttribute('data-section') || '';

    var partialPath;
    if (section === 'products') {
        partialPath = basePath + 'partials/products/' + slug + (lang === 'en' ? '' : '-' + lang) + '.html';
    } else {
        partialPath = basePath + 'partials/' + slug + (lang === 'en' ? '' : '-' + lang) + '.html';
    }

    // 6. Swap content via HTMX (skip for blog — it renders client-side)
    if (slug !== 'blog' && typeof htmx !== 'undefined' && document.getElementById('content-area')) {
        htmx.ajax('GET', partialPath, '#content-area');
    }

    // 6b. Re-render blog if present
    if (typeof initBlog === 'function') {
        initBlog();
    } else if (typeof window.reRenderBlog === 'function') {
        window.reRenderBlog();
    }

    // 7. Close mobile nav
    closeMobileNav();
}

// === Reveal Observer ===
var revealObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
        if (entry.isIntersecting) {
            entry.target.classList.add('revealed');
        }
    });
}, { threshold: 0.1 });

function observeRevealElements() {
    document.querySelectorAll('.section-reveal, .reveal, .reveal-fade-up, .reveal-fade-left, .reveal-fade-right, .reveal-scale').forEach(function(el) {
        if (!el.classList.contains('revealed')) {
            revealObserver.observe(el);
        }
    });
}

// === Stagger Animations (steps, roadmap) ===
function initStaggerAnimations() {
    var section = document.querySelector('.how-it-works.scroll-animated:not([data-observed])');
    if (!section) return;
    section.setAttribute('data-observed', 'true');

    var staggerObserver = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
            if (entry.isIntersecting) {
                var steps = entry.target.querySelectorAll('.step-item');
                steps.forEach(function(step, index) {
                    setTimeout(function() {
                        step.classList.add('step-visible');
                    }, index * 150);
                });
                setTimeout(function() {
                    entry.target.classList.add('steps-complete');
                }, steps.length * 150);
                staggerObserver.unobserve(entry.target);
            }
        });
    }, { threshold: 0.2 });

    staggerObserver.observe(section);
}

// === Init on DOMContentLoaded ===
document.addEventListener('DOMContentLoaded', function() {
    // Determine language
    var params = new URLSearchParams(window.location.search);
    var lang = params.get('lang') || localStorage.getItem('iam-lang') || 'nl';

    // Set initial state
    document.documentElement.setAttribute('data-lang', lang);
    localStorage.setItem('iam-lang', lang);

    // Update active lang button
    document.querySelectorAll('.lang-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
    });

    // If not default NL, swap to that language
    if (lang !== 'nl') {
        switchLang(lang);
    }

    // Init reveal observer
    observeRevealElements();

    // Init stagger animations
    initStaggerAnimations();
});

// === HTMX afterSwap hook ===
document.body.addEventListener('htmx:afterSwap', function() {
    setTimeout(function() {
        observeRevealElements();
        initStaggerAnimations();
        initProductGallery();
    }, 50);
});

// === Product Gallery ===
function initProductGallery() {
    document.querySelectorAll('.product-gallery').forEach(function(gallery) {
        var thumbs = gallery.querySelectorAll('.thumb[data-image]');
        var mainImg = gallery.querySelector('#mainProductImage');
        var mainWrap = gallery.querySelector('.gallery-main');
        if (!mainImg || thumbs.length === 0) return;

        var images = [];
        thumbs.forEach(function(t) { images.push(t.getAttribute('data-image')); });
        var currentIndex = 0;

        // Add nav arrows
        var prevBtn = document.createElement('button');
        prevBtn.className = 'gallery-nav prev';
        prevBtn.innerHTML = '&#8249;';
        prevBtn.setAttribute('aria-label', 'Previous image');
        var nextBtn = document.createElement('button');
        nextBtn.className = 'gallery-nav next';
        nextBtn.innerHTML = '&#8250;';
        nextBtn.setAttribute('aria-label', 'Next image');
        var counter = document.createElement('span');
        counter.className = 'gallery-counter';
        mainWrap.appendChild(prevBtn);
        mainWrap.appendChild(nextBtn);
        mainWrap.appendChild(counter);

        function goTo(idx) {
            currentIndex = (idx + images.length) % images.length;
            mainImg.src = images[currentIndex];
            thumbs.forEach(function(t, i) {
                t.classList.toggle('active', i === currentIndex);
            });
            counter.textContent = (currentIndex + 1) + ' / ' + images.length;
        }

        prevBtn.addEventListener('click', function(e) { e.stopPropagation(); goTo(currentIndex - 1); });
        nextBtn.addEventListener('click', function(e) { e.stopPropagation(); goTo(currentIndex + 1); });

        thumbs.forEach(function(thumb, i) {
            thumb.addEventListener('click', function() { goTo(i); });
        });

        // Lightbox
        var lightbox = document.createElement('div');
        lightbox.className = 'gallery-lightbox';
        var lbImg = document.createElement('img');
        var lbPrev = document.createElement('button');
        lbPrev.className = 'gallery-nav prev';
        lbPrev.innerHTML = '&#8249;';
        var lbNext = document.createElement('button');
        lbNext.className = 'gallery-nav next';
        lbNext.innerHTML = '&#8250;';
        var lbClose = document.createElement('button');
        lbClose.className = 'lightbox-close';
        lbClose.innerHTML = '&times;';
        lightbox.appendChild(lbImg);
        lightbox.appendChild(lbPrev);
        lightbox.appendChild(lbNext);
        lightbox.appendChild(lbClose);
        document.body.appendChild(lightbox);

        function openLightbox() {
            lbImg.src = images[currentIndex];
            lightbox.classList.add('active');
            document.body.style.overflow = 'hidden';
        }
        function closeLightbox() {
            lightbox.classList.remove('active');
            document.body.style.overflow = '';
        }

        mainWrap.addEventListener('click', function(e) {
            if (e.target.closest('.gallery-nav')) return;
            openLightbox();
        });
        lbClose.addEventListener('click', closeLightbox);
        lightbox.addEventListener('click', function(e) {
            if (e.target === lightbox) closeLightbox();
        });
        lbPrev.addEventListener('click', function(e) { e.stopPropagation(); goTo(currentIndex - 1); lbImg.src = images[currentIndex]; });
        lbNext.addEventListener('click', function(e) { e.stopPropagation(); goTo(currentIndex + 1); lbImg.src = images[currentIndex]; });

        document.addEventListener('keydown', function(e) {
            if (!lightbox.classList.contains('active')) return;
            if (e.key === 'Escape') closeLightbox();
            if (e.key === 'ArrowLeft') { goTo(currentIndex - 1); lbImg.src = images[currentIndex]; }
            if (e.key === 'ArrowRight') { goTo(currentIndex + 1); lbImg.src = images[currentIndex]; }
        });

        goTo(0);
    });
}

// Init on load
document.addEventListener('DOMContentLoaded', function() {
    initProductGallery();
});

// === Desktop dropdown close on outside click ===
document.addEventListener('click', function(e) {
    if (!e.target.closest('.nav-item.dropdown')) {
        document.querySelectorAll('.dropdown-menu').forEach(function(menu) {
            menu.style.display = '';
        });
    }
});
