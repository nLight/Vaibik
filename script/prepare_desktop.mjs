import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'build');
const resources = path.resolve(process.env.VIBEMIC_RESOURCES || path.join(build, 'desktop-resources'));
const version = '1.9.5';
const sha256 = 'ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720';
const extension = process.platform === 'win32' ? '.exe' : '';
const tool = 'whisper-cli' + extension;
const source = path.join(build, `whisper.cpp-${version}`);
const architecture = process.platform === 'darwin' ? process.env.VIBEMIC_MAC_ARCH || process.arch : process.arch;
if (process.platform === 'darwin' && !['arm64', 'x64'].includes(architecture)) {
    throw new Error('VIBEMIC_MAC_ARCH must be arm64 or x64.');
}
const macArchitecture = architecture === 'x64' ? 'x86_64' : architecture;
const compilation = path.join(build, `whisper-${process.platform}-${architecture}`);

function run(command, args) {
    const output = spawnSync(command, args, { stdio: 'inherit' });
    if (output.error) throw output.error;
    if (output.status !== 0) throw new Error(`${command} exited with status ${output.status}.`);
}

async function exists(file) {
    return fs.access(file).then(() => true, () => false);
}

await fs.mkdir(path.join(resources, 'firmware'), { recursive: true });
await fs.mkdir(path.join(resources, 'engine'), { recursive: true });
for (const [short, role] of [['tx', 'transmitter'], ['rx', 'receiver'], ['tx-probe', 'mic-probe']]) {
    for (const variant of ['', '-s140v7']) {
        const from = path.join(build, `promicro-${short}${variant}`, 'zephyr', 'zephyr.uf2');
        if (!(await exists(from))) throw new Error('Build the Pro Micro images with script/build_firmware.sh first.');
        await fs.copyFile(from, path.join(resources, 'firmware', `promicro-${role}${variant}.uf2`));
    }
}

let runtime = process.env.VIBEMIC_WHISPER_CLI;
if (!runtime) {
    const archive = path.join(build, `whisper-v${version}.tar.gz`);
    if (!(await exists(archive))) {
        const response = await fetch(`https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v${version}`,
            { signal: AbortSignal.timeout(90000) });
        if (!response.ok) throw new Error(`Whisper source returned ${response.status}.`);
        const data = Buffer.from(await response.arrayBuffer());
        if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('Whisper source checksum mismatch.');
        await fs.writeFile(archive, data);
    } else if (createHash('sha256').update(await fs.readFile(archive)).digest('hex') !== sha256) {
        throw new Error('Whisper source checksum mismatch.');
    }
    if (!(await exists(path.join(source, 'CMakeLists.txt')))) run('tar', ['-xf', archive, '-C', build]);
    run('cmake', ['-S', source, '-B', compilation, '-DCMAKE_BUILD_TYPE=Release',
        '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DGGML_METAL=OFF', '-DGGML_OPENMP=OFF',
        '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF',
        // ggml's Apple BLAS backend imports the new LAPACK ABI from macOS 13.3.
        ...(process.platform === 'darwin' ? ['-DGGML_BLAS=OFF', '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0',
            `-DCMAKE_OSX_ARCHITECTURES=${macArchitecture}`] : []),
        ...(process.platform === 'win32' ? ['-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'] : [])]);
    run('cmake', ['--build', compilation, '--config', 'Release', '--target', 'whisper-cli', '--parallel', '6']);
    runtime = path.join(compilation, 'bin', tool);
    if (!(await exists(runtime))) runtime = path.join(compilation, 'bin', 'Release', tool);
    await fs.copyFile(path.join(source, 'LICENSE'), path.join(resources, 'engine', 'LICENSE.whisper.cpp'));
} else {
    const license = path.join(path.dirname(runtime), 'LICENSE.whisper.cpp');
    if (await exists(license)) await fs.copyFile(license, path.join(resources, 'engine', 'LICENSE.whisper.cpp'));
}
await fs.copyFile(runtime, path.join(resources, 'engine', tool));
if (process.platform !== 'win32') await fs.chmod(path.join(resources, 'engine', tool), 0o755);

const helperName = 'vibemic-desktop-draft' + extension;
const helper = path.join(resources, 'engine', helperName);
if (process.env.VIBEMIC_DRAFT_HELPER) {
    await fs.copyFile(process.env.VIBEMIC_DRAFT_HELPER, helper);
} else if (process.platform === 'darwin') {
    const ptyHelpers = path.join(root, 'desktop', 'node_modules', 'node-pty', 'prebuilds');
    for (const arch of ['arm64', 'x64']) {
        const binary = path.join(ptyHelpers, `darwin-${arch}`, 'spawn-helper');
        if (await exists(binary)) await fs.chmod(binary, 0o755);
    }
    const swift = path.join(root, 'host', 'macos');
    const cache = path.join(build, 'swift-desktop-cache');
    await fs.mkdir(cache, { recursive: true });
    run('xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', '-O',
        '-module-cache-path', cache, '-target', `${macArchitecture}-apple-macosx13.0`,
        path.join(swift, 'Support.swift'), path.join(swift, 'Destination.swift'),
        path.join(swift, 'desktop-draft', 'main.swift'), '-o', helper]);
    run('/usr/bin/codesign', ['--force', '--sign', '-', helper]);
} else if (process.platform === 'win32') {
    const helperBuild = path.join(build, 'desktop-draft-windows');
    run('cmake', ['-S', path.join(root, 'host', 'windows'), '-B', helperBuild, '-DCMAKE_BUILD_TYPE=Release']);
    run('cmake', ['--build', helperBuild, '--config', 'Release']);
    const release = path.join(helperBuild, 'Release', helperName);
    await fs.copyFile(await exists(release) ? release : path.join(helperBuild, helperName), helper);
}
console.log(resources);
