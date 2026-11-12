'use strict';
// Display-only translation. URLs, file paths and technical identifiers retain
// their exact spelling even inside a human-readable status line.
const i18n = require('./kit/i18n');
const protectedText = /(https?:\/\/[^\s]+|(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@/-]+|\/(?:[A-Za-z0-9_.@-]+\/?)+)/g;
module.exports = function displayText(value) {
    const s = String(value == null ? '' : value);
    return s.split(protectedText).map((part, i) => {
        if (i % 2) return part;
        return i18n.t(part).replace(/\boil(?=\s+-?\d)/g, 'масло')
            .replace(/\braw:/g, 'исходное:').replace(/\bpanel:/g, 'панель:')
            .replace(/(\d+) of (?=\d)/g, '$1 из ');
    }).join('');
};
