#!/usr/bin/env node
// patrick-ops: read-only MCP server (stdio) giving the DM agent real server
// facts. No dependencies, so update_bot.sh's root `npm ci` is all it ever needs.
// Every tool runs fixed commands; the only input is a bounded enum or integer.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const HOME = process.env.HOME || '/home/birds';
const LOG_SERVICES = ['discordbot', 'opencode-serve'];

function sh(file, args = [], timeout = 15000) {
    return new Promise((resolve) => {
        execFile(file, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
            const out = String(stdout || '').trim();
            if (err) resolve(`${out}\n[${file} failed: ${String(stderr || err.message).trim().slice(0, 300)}]`.trim());
            else resolve(out);
        });
    });
}

function newestFiles(dir, count) {
    try {
        return fs.readdirSync(dir)
            .map((name) => {
                const full = path.join(dir, name);
                return { name, full, stat: fs.statSync(full) };
            })
            .filter(f => f.stat.isFile())
            .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
            .slice(0, count);
    } catch (err) {
        return [];
    }
}

function clampLines(value, fallback = 50) {
    const n = Number.isInteger(value) ? value : fallback;
    return Math.min(Math.max(n, 1), 300);
}

const section = (title, body) => `## ${title}\n${body || '(none)'}`;

const TOOLS = {
    system_status: {
        description: 'Uptime, load average, memory, and top CPU processes.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => [
            section('uptime', await sh('uptime')),
            section('memory', await sh('free', ['-h'])),
            section('top processes', (await sh('ps', ['-eo', 'pid,pcpu,pmem,etime,comm', '--sort=-pcpu'])).split('\n').slice(0, 11).join('\n')),
        ].join('\n\n'),
    },
    disk_usage: {
        description: 'Filesystem usage for real disks.',
        inputSchema: { type: 'object', properties: {} },
        run: () => sh('df', ['-h', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'overlay']),
    },
    tail_logs: {
        description: 'Recent journal lines for a service on this server.',
        inputSchema: {
            type: 'object',
            properties: {
                service: { type: 'string', enum: LOG_SERVICES },
                lines: { type: 'integer', minimum: 1, maximum: 300 },
            },
            required: ['service'],
        },
        run: async ({ service, lines }) => {
            if (!LOG_SERVICES.includes(service)) return `Unknown service. Use one of: ${LOG_SERVICES.join(', ')}`;
            return sh('journalctl', ['-u', service, '-n', String(clampLines(lines)), '--no-pager', '-o', 'short-iso']);
        },
    },
    bot_health: {
        description: 'Whether Patrick (discordbot) is running, since when, and recent error lines.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => [
            section('service', await sh('systemctl', ['show', 'discordbot', '--property=ActiveState,SubState,ActiveEnterTimestamp,NRestarts'])),
            section('recent errors (24h)', await sh('journalctl', ['-u', 'discordbot', '--since', '24 hours ago', '-p', 'err', '-n', '30', '--no-pager', '-o', 'short-iso'])),
        ].join('\n\n'),
    },
    docker_list: {
        description: 'All Docker containers with image, state and status.',
        inputSchema: { type: 'object', properties: {} },
        run: () => sh('docker', ['ps', '-a', '--format', 'table {{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}']),
    },
    backup_status: {
        description: 'Newest backup logs with the tail of the latest one, plus the user crontab.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
            const logs = newestFiles(path.join(HOME, 'backup-logs'), 5);
            const listing = logs.map(f => `${f.stat.mtime.toISOString()}  ${f.name}`).join('\n');
            const latest = logs[0] ? await sh('tail', ['-n', '20', logs[0].full]) : '';
            return [
                section('newest logs', listing),
                section('latest log tail', latest),
                section('crontab', await sh('crontab', ['-l'])),
            ].join('\n\n');
        },
    },
    reencode_status: {
        description: 'Running ffmpeg processes and the newest reencode logs.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
            const procs = (await sh('ps', ['-eo', 'pid,etime,pcpu,args'])).split('\n').filter(l => /ffmpeg/.test(l));
            const logs = newestFiles(path.join(HOME, 'reencode_logs'), 5);
            return [
                section('running ffmpeg', procs.map(l => l.slice(0, 200)).join('\n')),
                section('newest logs', logs.map(f => `${f.stat.mtime.toISOString()}  ${f.name}`).join('\n')),
                section('latest log tail', logs[0] ? await sh('tail', ['-n', '5', logs[0].full]) : ''),
            ].join('\n\n');
        },
    },
};

function respond(id, result) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, code, message) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handle(msg) {
    const { id, method, params } = msg;
    if (id === undefined) return; // notifications need no reply
    if (method === 'initialize') {
        return respond(id, {
            protocolVersion: params?.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'patrick-ops', version: '1.0.0' },
        });
    }
    if (method === 'ping') return respond(id, {});
    if (method === 'tools/list') {
        return respond(id, {
            tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
        });
    }
    if (method === 'tools/call') {
        const tool = TOOLS[params?.name];
        if (!tool) return respondError(id, -32602, `Unknown tool: ${params?.name}`);
        try {
            const text = await tool.run(params.arguments || {});
            return respond(id, { content: [{ type: 'text', text: String(text).slice(0, 20000) }] });
        } catch (err) {
            return respond(id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
    }
    respondError(id, -32601, `Method not found: ${method}`);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
        msg = JSON.parse(line);
    } catch (err) {
        return;
    }
    handle(msg).catch(err => respondError(msg.id ?? null, -32603, err.message));
});
