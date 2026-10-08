const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserProxyArgs } = require('../browser_proxy');
const { browserOptions } = require('../browser');

test('browser routes HTTP and HTTPS through the configured proxies and keeps bypass rules', () => {
    assert.deepEqual(browserProxyArgs({ HTTP_PROXY: 'http://proxy.example:8080', HTTPS_PROXY: 'http://proxy.example:8080',
        NO_PROXY: '.bosch.com, localhost,127.0.0.1' }), [
        '--proxy-server=http=http://proxy.example:8080;https=http://proxy.example:8080',
        '--proxy-bypass-list=.bosch.com;localhost;127.0.0.1'
    ]);
    assert.deepEqual(browserProxyArgs({ http_proxy: 'http://one.example:3128/', https_proxy: 'https://two.example:8443/',
        no_proxy: '[::1],.internal' }), [
        '--proxy-server=http=http://one.example:3128;https=https://two.example:8443',
        '--proxy-bypass-list=[::1];.internal'
    ]);
    assert.deepEqual(browserProxyArgs({ HTTPS_PROXY: 'http://proxy.example:8080' }), [
        '--proxy-server=https=http://proxy.example:8080'
    ]);
    assert.deepEqual(browserProxyArgs({ NO_PROXY: '*' }), []);
});

test('invalid proxy settings fail without leaking embedded credentials', () => {
    for (const value of ['invalid', 'http://user:private-password@proxy.example:8080', 'file:///tmp/proxy', 'http://proxy.example/path']) {
        assert.throws(() => browserProxyArgs({ HTTPS_PROXY: value }), error => {
            assert.match(error.message, /HTTPS_PROXY/);
            assert.doesNotMatch(error.message, /private-password/);
            return true;
        });
    }
});

test('browser launcher applies environment proxy settings without overriding an explicit browser proxy', () => {
    const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
    const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
    try {
        for (const name of names) delete process.env[name];
        process.env.HTTP_PROXY = 'http://proxy.example:8080';
        process.env.HTTPS_PROXY = 'http://proxy.example:8080';
        const options = browserOptions({ args: ['--disable-http2'] });
        assert.ok(options.args.includes('--proxy-server=http=http://proxy.example:8080;https=http://proxy.example:8080'));
        assert.ok(options.args.includes('--disable-http2'));
        assert.ok(options.args.includes('--no-sandbox'));
        const explicit = browserOptions({ args: ['--proxy-server=http://override.example:8080'] });
        assert.deepEqual(explicit.args.filter(arg => arg.startsWith('--proxy-server=')), ['--proxy-server=http://override.example:8080']);
        assert.equal(browserOptions({ args: ['--no-proxy-server'] }).args.some(arg => arg.startsWith('--proxy-server=')), false);
    } finally {
        for (const name of names) {
            if (before[name] === undefined) delete process.env[name];
            else process.env[name] = before[name];
        }
    }
});
