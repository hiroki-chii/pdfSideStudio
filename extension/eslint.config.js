const browserGlobals = ['window', 'document', 'chrome', 'self', 'console', 'performance', 'crypto',
  'URL', 'Blob', 'Worker', 'BroadcastChannel', 'indexedDB', 'ResizeObserver', 'IntersectionObserver', 'location', 'Node', 'NodeFilter',
  'Event', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'structuredClone'];

export default [{
  files: ['src/**/*.js', 'public/**/*.js'],
  languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: Object.fromEntries(browserGlobals.map(name => [name, 'readonly'])) },
  rules: {
    'no-undef': 'error',
    'no-unreachable': 'error',
    'valid-typeof': 'error',
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  },
}];
