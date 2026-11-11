import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'build');
const resources = path.resolve(process.env.VIBEMIC_RESOURCES || path.join(build, 'desktop-resources'));
const version = '0.3.0';
const extension = process.platform === 'win32' ? '.exe' : '';
const tool = 'nemo-speech' + extension;
const architecture = process.platform === 'darwin' ? process.env.VIBEMIC_MAC_ARCH || process.arch : process.arch;
if (process.platform === 'darwin' && !['arm64', 'x64'].includes(architecture)) {
    throw new Error('VIBEMIC_MAC_ARCH must be arm64 or x64.');
}
const macArchitecture = architecture === 'x64' ? 'x86_64' : architecture;


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
for (const [short, role] of [['tx', 'transmitter'], ['rx', 'receiver'], ['tx-probe', 'mic-probe'], ['tx-v2-battery', 'transmitter-v2-battery']]) {
    for (const variant of ['', '-s140v7']) {
        const from = path.join(build, `promicro-${short}${variant}`, 'zephyr', 'zephyr.uf2');
        if (!(await exists(from))) throw new Error('Build the Pro Micro images with script/build_firmware.sh first.');
        await fs.copyFile(from, path.join(resources, 'firmware', `promicro-${role}${variant}.uf2`));
    }
}

const distributions = {
    'darwin-arm64': ['macos-aarch64-metal.tar.gz', '2b972ed8b5dba07492212acf8cb75cbf34ecb141198ffa1997febe84b7c4d9ed'],
    'darwin-x64': ['macos-x86_64-cpu.tar.gz', '97e98aa5eb82dffa4f513f26336b5301d792c9fb43f720ac8f9520a0e92ffe3f'],
    'linux-arm64': ['linux-aarch64-cpu.tar.gz', '56858eaf50d19b05902c043f65d0057352bdc107ae380c41053bfbddfc204bf1'],
    'linux-x64': ['linux-x86_64-cpu.tar.gz', '255f12b722ab15b2a38a51cf125d56e3fa97058b528f7e895b39d6a473deb06e'],
    'win32-x64': ['windows-x86_64-cpu.zip', '4ed9740e361e4653f56c3dce7d1e81883a1c8b831c1bd7d01567fff1130b5b05']
};
let runtime = process.env.VIBEMIC_NEMO_RUNTIME;
if (!runtime) {
    const distribution = distributions[`${process.platform}-${architecture}`];
    if (!distribution) throw new Error('No pinned Parakeet runtime for this platform.');
    const [suffix, sha256] = distribution;
    const name = `nemo-speech-${version}-${suffix}`;
    const archive = path.join(build, name);
    if (!(await exists(archive))) {
        const url = `https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v${version}/${name}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`Parakeet runtime returned ${response.status}.`);
        const data = Buffer.from(await response.arrayBuffer());
        if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('Parakeet runtime checksum mismatch.');
        await fs.writeFile(archive, data);
    } else if (createHash('sha256').update(await fs.readFile(archive)).digest('hex') !== sha256) {
        throw new Error('Parakeet runtime checksum mismatch.');
    }
    const extracted = path.join(build, `nemo-${process.platform}-${architecture}`);
    await fs.mkdir(extracted, { recursive: true });
    run('tar', ['-xf', archive, '-C', extracted]);
    runtime = path.join(extracted, name.replace(/\.(tar\.gz|zip)$/, ''));
}
if (!(await exists(path.join(runtime, 'bin', tool)))) throw new Error('Parakeet runtime is missing its executable.');
const destination = path.join(resources, 'engine', 'nemo');
await fs.rm(destination, { recursive: true, force: true });
await fs.cp(runtime, destination, { recursive: true, verbatimSymlinks: true });
await fs.rm(path.join(resources, 'engine', 'whisper-cli' + extension), { force: true });

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
        path.join(swift, 'Approval.swift'),
        path.join(swift, 'NativeDictation.swift'),
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
