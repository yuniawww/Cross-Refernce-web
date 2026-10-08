function assertSupportedRuntime(version = process.versions.node) {
    const [major, minor] = version.split('.').map(Number);
    if (major !== 22 || minor < 18 || !Number.isInteger(minor)) {
        throw new Error(`当前 Node.js ${version} 不符合要求，需要 >=22.18.0 <23。请执行 nvm install 22 && nvm use 22 后重试。`);
    }
}

function checkRuntimeOrExit() {
    try { assertSupportedRuntime(); }
    catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = { assertSupportedRuntime, checkRuntimeOrExit };
