export function buildTextRequest(model: string): any;
export function buildSonnetFirstRequest(model: string): any;
export function buildSonnetContinuation(model: string, first: any): any;
export function buildGrokFirstRequest(model: string): any;
export function buildGrokContinuation(model: string, first: any): any;
export function runSmoke(env?: NodeJS.ProcessEnv): Promise<Record<string, string>>;
