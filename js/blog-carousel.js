// Blog carousel — loads posts from local data
(function() {
    function loadBlogCarousel() {
        try {
            const currentLang = new URLSearchParams(window.location.search).get('lang') || localStorage.getItem('iam-lang') || 'nl';
            const isEn = currentLang === 'en';
            const posts = BLOG_LOCAL_DATA;
            const carousel = document.getElementById('blog-carousel');
            if (!carousel) return;

            if (!posts || posts.length === 0) {
                var empty = document.getElementById('blog-carousel-empty');
                if (empty) empty.style.display = 'block';
                carousel.style.display = 'none';
                return;
            }

            const t = (post, field) => post[field + '_' + currentLang] || post[field + '_nl'];

            // Show up to 6 posts
            carousel.innerHTML = posts.slice(0, 6).map(function(post) {
                var date = new Date(post.published_at).toLocaleDateString(isEn ? 'en-GB' : 'nl-NL', {
                    year: 'numeric', month: 'short', day: 'numeric'
                });
                var excerpt = t(post, 'excerpt') || '';
                var title = t(post, 'title');
                var tag = post.tags && post.tags[0] ? (post.tags[0]['name_' + currentLang] || post.tags[0].name_nl) : (isEn ? 'News' : 'Nieuws');
                var img = post.feature_image
                    ? '<img src="' + post.feature_image + '" alt="' + title + '" loading="lazy">'
                    : '<div class="card-placeholder"><svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zm-5-7l-3 3.72L9 13l-3 4h12l-4-5z"/></svg></div>';
                var langSuffix = currentLang === 'en' ? '&lang=en' : '';
                return '<a href="/blog?post=' + post.slug + langSuffix + '" class="blog-carousel-card">' +
                    img +
                    '<div class="card-body">' +
                    '<span class="card-tag">' + tag + '</span>' +
                    '<h3>' + title + '</h3>' +
                    '<p class="card-excerpt">' + excerpt.substring(0, 120) + (excerpt.length > 120 ? '...' : '') + '</p>' +
                    '<div class="card-meta">' +
                    '<span>' + date + '</span>' +
                    '<span class="read-more">' + (isEn ? 'Read more →' : 'Lees meer →') + '</span>' +
                    '</div></div></a>';
            }).join('');
        } catch (e) {
            console.error('Carousel error:', e);
            var empty = document.getElementById('blog-carousel-empty');
            if (empty) empty.style.display = 'block';
        }
    }

    window.scrollBlogCarousel = function(dir) {
        var c = document.getElementById('blog-carousel');
        if (c) c.scrollBy({ left: dir * 360, behavior: 'smooth' });
    };

    document.addEventListener('DOMContentLoaded', loadBlogCarousel);
    document.body.addEventListener('htmx:afterSwap', loadBlogCarousel);
})();
