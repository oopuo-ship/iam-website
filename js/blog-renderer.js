/**
 * Blog Renderer for InterActiveMove
 * Handles both List View and Single Post View with Groq-style clean layout
 */
(function() {
    function initBlog() {
        const app = document.getElementById('blog-app');
        if (!app) return;

        const params = new URLSearchParams(window.location.search);
        const postSlug = params.get('post');
        const currentLang = params.get('lang') || localStorage.getItem('iam-lang') || 'nl';
        const isEn = currentLang === 'en';

        // Translation helper
        const t = (obj, field) => obj[field + '_' + currentLang] || obj[field + '_nl'] || '';

        // Labels
        const labels = {
            blogTitle: isEn ? 'Blog' : 'Blog',
            readMore: isEn ? 'Read Blog' : 'Lees meer',
            backToBlog: isEn ? 'Back' : 'Terug',
            relatedPosts: isEn ? 'Related' : 'Gerelateerd',
            news: isEn ? 'Blog' : 'Blog',
            publishedOn: isEn ? 'Published on' : 'Gepubliceerd op',
            readTime: isEn ? 'min read' : 'min leestijd',
            ctaTitle: isEn ? 'Interested in our solutions?' : 'Geinteresseerd in onze oplossingen?',
            ctaText: isEn ? 'Get in touch and discover what InterActiveMove can do for your organization.' : 'Neem contact op en ontdek wat InterActiveMove voor uw organisatie kan betekenen.',
            ctaBtn: isEn ? 'Contact Us' : 'Neem Contact Op',
            emptyTitle: isEn ? 'No posts yet' : 'Nog geen berichten',
            emptyText: isEn ? 'Check back soon for new articles.' : 'Kom binnenkort terug voor nieuwe artikelen.'
        };

        if (postSlug) {
            renderSinglePost(app, postSlug, currentLang, labels, t);
        } else {
            renderBlogList(app, currentLang, labels, t);
        }
    }

    function formatDate(dateStr, lang) {
        const date = new Date(dateStr);
        const months = {
            nl: ['JAN', 'FEB', 'MRT', 'APR', 'MEI', 'JUN', 'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEC'],
            en: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
        };
        const m = months[lang] || months.nl;
        return `${m[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    }

    function estimateReadTime(html) {
        const text = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        const words = text.split(' ').filter(w => w.length > 0).length;
        return Math.max(1, Math.ceil(words / 200));
    }

    function stripWordPressArtifacts(html) {
        // Remove Elementor classes
        html = html.replace(/\sclass="[^"]*elementor[^"]*"/gi, '');
        // Remove wp-content URLs in img src/srcset
        html = html.replace(/<img[^>]*src="[^"]*wp-content\/uploads[^"]*"[^>]*\/?>/gi, '');
        // Remove srcset attributes
        html = html.replace(/\s*srcset="[^"]*"/gi, '');
        // Remove WordPress data-* attributes
        html = html.replace(/\s*data-(?:widget_type|id|element_type|settings|src)="[^"]*"/gi, '');
        // Remove empty anchor tags left behind
        html = html.replace(/<a[^>]*href="[^"]*wp-content\/uploads[^"]*"[^>]*>.*?<\/a>/gi, '');
        // Remove empty figures
        html = html.replace(/<figure[^>]*>\s*<\/figure>/gi, '');
        // Remove empty divs with elementor classes
        html = html.replace(/<div[^>]*class="[^"]*elementor[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
        return html;
    }

    function renderBlogList(container, lang, labels, t) {
        const posts = typeof BLOG_LOCAL_DATA !== 'undefined' ? BLOG_LOCAL_DATA : [];
        if (!posts || posts.length === 0) {
            container.innerHTML = `
                <div class="blog-light-wrapper">
                    <div class="blog-content-container">
                        <div class="blog-header">
                            <h1 class="blog-page-title">${labels.blogTitle}</h1>
                            <hr class="blog-title-sep">
                        </div>
                        <div class="blog-empty-state">
                            <h2>${labels.emptyTitle}</h2>
                            <p>${labels.emptyText}</p>
                        </div>
                    </div>
                </div>`;
            return;
        }

        // Featured post is the newest (index 0, sorted by date)
        const featuredPost = posts[0];
        const otherPosts = posts.slice(1);

        let html = `
            <div class="blog-light-wrapper">
                <div class="blog-content-container">
                    <div class="blog-header">
                        <h1 class="blog-page-title">${labels.blogTitle}</h1>
                        <hr class="blog-title-sep">
                    </div>

                    <!-- Featured Post -->
                    <section class="featured-post-section">
                        ${renderFeaturedCard(featuredPost, lang, labels, t)}
                    </section>

                    <!-- Post Grid -->
                    <section class="posts-grid-section">
                        <div class="blog-posts-grid">
                            ${otherPosts.map(post => renderGridCard(post, lang, labels, t)).join('')}
                        </div>
                    </section>
                </div>
            </div>
        `;

        container.innerHTML = html;
        window.scrollTo(0, 0);
    }

    function renderFeaturedCard(post, lang, labels, t) {
        const title = t(post, 'title');
        const excerpt = t(post, 'excerpt').replace(/\[&hellip;\]/g, '...');
        const tag = post.tags && post.tags[0] ? (post.tags[0]['name_' + lang] || post.tags[0].name_nl) : labels.news;
        const langParam = lang === 'en' ? '&lang=en' : '';
        const url = `/blog?post=${post.slug}${langParam}`;
        const content = t(post, 'html');
        const readMin = estimateReadTime(content);

        return `
            <div class="featured-card">
                <div class="featured-card-content">
                    <span class="featured-tag">${tag}</span>
                    <h2 class="featured-title">${title}</h2>
                    <div class="featured-meta">${formatDate(post.published_at, lang)} &middot; ${readMin} ${labels.readTime}</div>
                    <p class="featured-excerpt">${excerpt.substring(0, 200)}${excerpt.length > 200 ? '...' : ''}</p>
                    <a href="${url}" class="featured-btn">${labels.readMore}</a>
                </div>
                <div class="featured-card-image">
                    <img src="${post.feature_image}" alt="${title}" loading="lazy">
                </div>
            </div>
        `;
    }

    function renderGridCard(post, lang, labels, t) {
        const title = t(post, 'title');
        const dateStr = formatDate(post.published_at, lang);
        const langParam = lang === 'en' ? '&lang=en' : '';
        const url = `/blog?post=${post.slug}${langParam}`;
        const content = t(post, 'html');
        const readMin = estimateReadTime(content);

        return `
            <a href="${url}" class="grid-card">
                <div class="grid-card-date">${dateStr} &middot; ${readMin} ${labels.readTime}</div>
                <div class="grid-card-image">
                    <img src="${post.feature_image}" alt="${title}" loading="lazy">
                </div>
                <h3 class="grid-card-title">${title}</h3>
            </a>
        `;
    }

    function renderSinglePost(container, slug, lang, labels, t) {
        const posts = typeof BLOG_LOCAL_DATA !== 'undefined' ? BLOG_LOCAL_DATA : [];
        const post = posts.find(p => p.slug === slug);

        if (!post) {
            container.innerHTML = `<div class="blog-light-wrapper"><div class="blog-content-container" style="padding: 10rem 0; text-align: center;"><h1>Post not found</h1><a href="/blog" class="back-link">${labels.backToBlog}</a></div></div>`;
            return;
        }

        const title = t(post, 'title');
        const rawContent = t(post, 'html');
        const content = stripWordPressArtifacts(rawContent);
        const dateStr = formatDate(post.published_at, lang);
        const readMin = estimateReadTime(content);
        const tag = post.tags && post.tags[0] ? (post.tags[0]['name_' + lang] || post.tags[0].name_nl) : labels.news;
        const langParam = lang === 'en' ? '?lang=en' : '';

        let html = `
            <div class="blog-light-wrapper single-post-wrapper">
                <div class="post-hero-banner${post.feature_image ? '' : ' post-hero-no-image'}"${post.feature_image ? ` style="background-image: url('${post.feature_image}')"` : ''}>
                    <div class="post-hero-overlay"></div>
                    <div class="post-hero-content">
                        <a href="/blog${langParam}" class="back-link-hero">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                            ${labels.backToBlog}
                        </a>
                        <div class="post-hero-meta">${dateStr} &middot; ${readMin} ${labels.readTime}</div>
                        <h1 class="post-hero-title">${title}</h1>
                    </div>
                </div>

                <article class="blog-content-container single-post-view">
                    <div class="post-detail-content">
                        ${content}
                    </div>

                    <div class="post-cta">
                        <h3 class="post-cta-title">${labels.ctaTitle}</h3>
                        <p class="post-cta-text">${labels.ctaText}</p>
                        <a href="/#contact" class="post-cta-btn">${labels.ctaBtn}</a>
                    </div>

                    ${renderRelatedGrid(post, lang, labels, t)}
                </article>
            </div>
        `;

        container.innerHTML = html;
        window.scrollTo(0, 0);
    }

    function renderRelatedGrid(currentPost, lang, labels, t) {
        const posts = typeof BLOG_LOCAL_DATA !== 'undefined' ? BLOG_LOCAL_DATA : [];
        const related = posts
            .filter(p => p.slug !== currentPost.slug)
            .slice(0, 4);

        if (related.length === 0) return '';

        return `
            <section class="related-section">
                <h2 class="related-title">${labels.relatedPosts}</h2>
                <div class="blog-posts-grid mini">
                    ${related.map(post => renderGridCard(post, lang, labels, t)).join('')}
                </div>
            </section>
        `;
    }

    // Initialize on load
    document.addEventListener('DOMContentLoaded', initBlog);
    window.addEventListener('popstate', initBlog);
    window.reRenderBlog = initBlog;

    const originalSwitchLang = window.switchLang;
    window.switchLang = function(lang) {
        if (originalSwitchLang) originalSwitchLang(lang);
        setTimeout(initBlog, 50);
    };
})();
