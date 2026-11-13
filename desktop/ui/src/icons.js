export const iconPaths = {
    wave: '<path d="M2 12h4l3-7 4 14 3-9 2 2h4"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
    gear: '<path d="M9.5 3h5l.6 2.6 2.3 1.3 2.6-.8 2.5 4.3-2 1.8v2.6l2 1.8-2.5 4.3-2.6-.8-2.3 1.3-.6 2.6h-5l-.6-2.6-2.3-1.3-2.6.8-2.5-4.3 2-1.8v-2.6l-2-1.8 2.5-4.3 2.6.8 2.3-1.3z" transform="translate(2 1) scale(.83)"/><circle cx="12" cy="12.2" r="2.8"/>',
    back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3"/>',
    mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-3 0h6"/>',
    usb: '<path d="M12 22V3m-3 4 3-4 3 4M12 18l-5-4v-3m5 5 5-4V9"/><circle cx="7" cy="9" r="2"/><rect x="15.5" y="6" width="3" height="3"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    corner: '<path d="M20 5v8a3 3 0 0 1-3 3H4m5-5-5 5 5 5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2 6m2-11v5h-5"/>',
    flash: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    sound: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
    mute: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6m0-6-5 6"/>',
    radio: '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4m8.4-8.4a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2m14.2-14.2a10 10 0 0 1 0 14.2"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 21h16"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/><rect x="4.5" y="9.5" width="7" height="5" rx="1" fill="currentColor" stroke="none"/>',
    sliders: '<path d="M4 6h10m4 0h2M4 12h2m4 0h10M4 18h12m4 0h0"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4M18 9h4m-4 6h4"/>'
};

export function icons(root = document) {
    root.querySelectorAll('[data-icon]:empty').forEach(element => {
        const path = iconPaths[element.dataset.icon];
        if (path) element.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
    });
}
