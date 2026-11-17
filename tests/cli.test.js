'use strict';

/**
 * تست ابزار خط فرمان (جانشین tests/test_cli.py نسخهٔ پایتون):
 * همگامی نسخهٔ صفحه با سرور + دستورهای مدیریتی.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const execFileP = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'server', 'cli.js');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jvl-cli-'));

const Config = require('../server/config');

function cli(args, extraEnv = {}) {
    return execFileP(process.execPath, [CLI, ...args], {
        cwd: ROOT,
        env: { ...process.env, JVL_DATA_DIR: DATA, JVL_QUIET: '1', ...extraEnv },
        timeout: 60000
    }).then(r => ({ code: 0, out: r.stdout + r.stderr, stdout: r.stdout }))
        .catch(e => ({
            code: e.code == null ? 1 : e.code,
            out: (e.stdout || '') + (e.stderr || ''),
            stdout: e.stdout || ''
        }));
}

test('نسخهٔ صفحه (index.html) با Config.app_version یکی است', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const m = /const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(html);
    assert.ok(m, 'APP_VERSION در index.html پیدا نشد');
    assert.equal(m[1], Config.app_version);
});

test('cli version', async () => {
    const r = await cli(['version']);
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(Config.app_version));
});

test('cli doctor بدون مشکل اجرا می‌شود', async () => {
    const r = await cli(['doctor']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /همه‌چیز آماده است/);
    assert.match(r.out, /نسخهٔ index\.html/);
});

test('cli help برای دستور ناشناخته', async () => {
    const r = await cli(['blahblah']);
    assert.equal(r.code, 0);
    assert.match(r.out, /دستورها:/);
});

test('cli create-admin و list-users و stats', async () => {
    const created = await cli(['create-admin', 'root', 'rootpass']);
    assert.equal(created.code, 0, created.out);
    assert.match(created.out, /admin/);

    const dup = await cli(['create-admin', 'root', 'rootpass']);
    assert.equal(dup.code, 1);
    assert.match(dup.out, /از قبل وجود دارد/);

    const list = await cli(['list-users']);
    assert.equal(list.code, 0);
    assert.match(list.out, /root/);

    const stats = await cli(['stats', '--json']);
    assert.equal(stats.code, 0);
    const json = JSON.parse(stats.stdout);
    assert.equal(json.users, 1);
    assert.equal(json.messages, 0);
});

test('cli create-user بدون رمز، رمز تصادفی می‌سازد', async () => {
    const r = await cli(['create-user', 'member']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /رمز تصادفی:/);
});

test('cli promote و demote', async () => {
    assert.equal((await cli(['promote', 'member'])).code, 0);
    let stats = await cli(['list-users']);
    assert.match(stats.out, /member\s+admin/);
    assert.equal((await cli(['demote', 'member'])).code, 0);
    stats = await cli(['list-users']);
    assert.match(stats.out, /member\s+user/);
    assert.equal((await cli(['promote', 'nobody'])).code, 1);
});

test('cli reset --yes داده‌ها را پاک می‌کند', async () => {
    const refused = await cli(['reset']);
    assert.equal(refused.code, 1);

    const r = await cli(['reset', '--yes']);
    assert.equal(r.code, 0, r.out);
    const stats = await cli(['stats', '--json']);
    const json = JSON.parse(stats.stdout);
    assert.equal(json.users, 0);
});

test.after(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
});
