import messages from './translations.mjs';

let language = 'ru';
const originals = new Map();
const patterns = [];

function interpolate(template, values) {
    return template.replace(/\{(\d+)\}/g, (placeholder, index) => index in values ? String(values[index]) : placeholder);
}

function patternFor(template) {
    const indices = [];
    const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = escaped.replace(/\\\{(\d+)\\\}/g, (_, index) => {
        indices.push(Number(index));
        return '([\\s\\S]*?)';
    });
    return { expression: new RegExp('^' + expression + '$'), indices };
}

for (const [original, english] of Object.entries(messages)) {
    if (!originals.has(english)) originals.set(english, original);
    if (/\{\d+\}/.test(original)) {
        patterns.push({ original, english, ru: patternFor(original), en: patternFor(english) });
    }
}

export function setLanguage(value) {
    language = value === 'en' ? 'en' : 'ru';
}

export function translate(source, target = language) {
    if (typeof source !== 'string') return source;
    if (Object.hasOwn(messages, source)) return target === 'en' ? messages[source] : source;
    if (originals.has(source)) return target === 'en' ? source : originals.get(source);
    for (const entry of patterns) {
        for (const locale of ['ru', 'en']) {
            const pattern = entry[locale];
            const match = pattern.expression.exec(source);
            if (!match) continue;
            const values = [];
            pattern.indices.forEach((index, position) => { values[index] = match[position + 1]; });
            return interpolate(target === 'en' ? entry.english : entry.original, values);
        }
    }
    return source;
}

export function t(source, ...values) {
    if (!Array.isArray(source)) return translate(source);
    const key = source.map((part, index) => part + (index < values.length ? `{${index}}` : '')).join('');
    return interpolate(translate(key), values);
}

export function staticTranslations(root) {
    const text = [];
    const attributes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const original = node.data.trim();
        if (!Object.hasOwn(messages, original) || node.parentElement?.closest('script, style, textarea, #terminal')) continue;
        text.push({ node, original, before: node.data.match(/^\s*/)[0], after: node.data.match(/\s*$/)[0] });
    }
    for (const element of root.querySelectorAll('[aria-label], [title], [placeholder]')) {
        for (const name of ['aria-label', 'title', 'placeholder']) {
            const original = element.getAttribute(name);
            if (original && Object.hasOwn(messages, original)) attributes.push({ element, name, original });
        }
    }
    return () => {
        for (const { node, original, before, after } of text) {
            if (node.isConnected) node.data = before + t(original) + after;
        }
        for (const { element, name, original } of attributes) {
            if (element.isConnected) element.setAttribute(name, t(original));
        }
        document.documentElement.lang = language;
    };
}
