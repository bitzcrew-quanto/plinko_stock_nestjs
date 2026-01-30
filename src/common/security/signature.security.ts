import * as crypto from 'crypto'

export interface SignaturePayload {
    method: string;
    path: string;
    body?: any;
    timestamp: string;
}

export function buildSignatureData(payload: SignaturePayload): string {
    return (payload.method.toUpperCase() + payload.path + JSON.stringify(payload.body || {}) + payload.timestamp);
}

export function createSignature(
    payload: SignaturePayload,
    secret: string,
): string {
    const data = buildSignatureData(payload);

    return crypto.createHmac('sha256', secret).update(data).digest('hex');
}
