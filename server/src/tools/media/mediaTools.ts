// 媒体工具 → Python sidecar HTTP 代理
import { getEnv } from '../../framework/env.js';
import { makeId } from '../../utils/ids.js';
export const ttsTool = {
    name: 'text_to_speech', label: '文本转语音',
    description: '将文本合成为语音音频文件。',
    group: '媒体', tags: ['media', 'tts'],
    isReadOnly: true, isDestructive: false,
    jsonSchema: {
        type: 'object',
        properties: {
            text: { type: 'string', description: '要合成的文本' },
            voice: { type: 'string', description: '音色 ID' },
        },
        required: ['text'],
    },
    async handler(args, _runtime) {
        const text = args.text;
        const workerUrl = getEnv().MEDIA_WORKER_URL;
        if (!workerUrl)
            throw new Error('MEDIA_WORKER_URL 未配置');
        const res = await fetch(`${workerUrl}/media/tts`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: args.voice }), signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok)
            throw new Error(`TTS error: ${res.status}`);
        const result = await res.json();
        return {
            message: `语音合成完成`,
            payload: result, warnings: [], valueRefs: [],
            resultId: makeId('result'), source: 'media_worker',
        };
    },
};
export const digitalHumanTool = {
    name: 'generate_digital_human', label: '生成数字人视频',
    description: '用音频驱动数字形象生成说话视频。',
    group: '媒体', tags: ['media', 'avatar'],
    isReadOnly: false, isDestructive: true,
    jsonSchema: {
        type: 'object',
        properties: {
            audioPath: { type: 'string', description: '音频文件路径' },
            avatarPath: { type: 'string', description: '形象文件路径（可选）' },
        },
        required: ['audioPath'],
    },
    async handler(args, _runtime) {
        const workerUrl = getEnv().MEDIA_WORKER_URL;
        if (!workerUrl)
            throw new Error('MEDIA_WORKER_URL 未配置');
        const res = await fetch(`${workerUrl}/media/avatar`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args), signal: AbortSignal.timeout(300_000),
        });
        if (!res.ok)
            throw new Error(`Avatar error: ${res.status}`);
        const result = await res.json();
        return {
            message: `数字人视频已生成`,
            payload: result, warnings: [], valueRefs: [],
            resultId: makeId('result'), source: 'media_worker',
        };
    },
};