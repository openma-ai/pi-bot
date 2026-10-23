import { readFileSync } from 'node:fs';
for (let attempt = 0;; attempt++) {
    try {
        const config = JSON.parse(readFileSync('/data/control.json', 'utf8'));
        if (config.url !== 'http://127.0.0.1:8091')
            throw Error('Unexpected broker endpoint');
        const result = await fetch(config.url + '/state', {
            headers: {
                authorization: 'Bearer ' + config.token
            }, signal: AbortSignal.timeout(500)
        });
        if (result.ok)
            break;
    }
    catch { /* Do not log the broker credential or response. */
    }
    if (attempt >= 149)
        throw Error('Isolated desktop broker did not become ready');
    await new Promise(resolve => setTimeout(resolve, 200));
}
