import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {summarize,render} from './report.mjs';
test('public report combines both features',()=>{
 const input=JSON.parse(readFileSync(new URL('./fixtures.json',import.meta.url)));
 const before=JSON.stringify(input);
 assert.equal(render(summarize(input)), 'alpha: 2 events, 40 ms\nbeta: 1 events, 0 ms');
 assert.equal(JSON.stringify(input),before);
 assert.equal(render(summarize([])), 'No events');
});
test('unknown duration is not zero and ordering is stable',()=>{
 assert.equal(render(summarize([{project:'z',durationMs:null},{project:'a',durationMs:2}])), 'a: 1 events, 2 ms\nz: 1 events, unknown ms');
});
