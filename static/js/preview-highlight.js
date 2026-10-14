(function () {
    'use strict';

    let pending = null;
    const generations = new WeakMap();

    function load() {
        if (window.hljs) return Promise.resolve(window.hljs);
        if (pending) return pending;
        const source = document.querySelector('meta[name="preview-highlight-script"]')?.content;
        if (!source) return Promise.resolve(null);
        pending = new Promise(resolve => {
            const script = document.createElement('script');
            script.dataset.previewHighlight = '';
            script.src = source;
            script.async = true;
            let timer;
            const finish = value => {
                clearTimeout(timer);
                script.onload = script.onerror = null;
                script.remove();
                resolve(value);
            };
            script.onload = () => finish(window.hljs || null);
            script.onerror = () => finish(null);
            timer = setTimeout(() => finish(null), 10000);
            document.head.appendChild(script);
        }).then(value => {
            pending = null;
            return value;
        });
        return pending;
    }

    function stylesheet() {
        if (document.querySelector('link[data-preview-highlight]')) return;
        const source = document.querySelector('meta[name="preview-highlight-style"]')?.content;
        if (!source) return;
        const link = document.createElement('link');
        link.dataset.previewHighlight = '';
        link.rel = 'stylesheet';
        link.href = source;
        link.onerror = () => link.remove();
        document.head.appendChild(link);
    }

    window.PreviewHighlight = {
        async render(element, language, isCurrent = () => true) {
            const generation = (generations.get(element) || 0) + 1;
            generations.set(element, generation);
            const content = element.textContent;
            element.className = `language-${language}`;
            delete element.dataset.highlighted;
            stylesheet();
            const highlighter = await load();
            if (!highlighter || generations.get(element) !== generation
                    || element.textContent !== content || !isCurrent()) return;
            try {
                highlighter.highlightElement(element);
            } catch {
                // Syntax colors are optional; copying and editing use plain text.
                element.textContent = content;
                delete element.dataset.highlighted;
            }
        },
    };
})();
