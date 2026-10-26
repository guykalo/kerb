const base = 'https://guykalo.github.io/kerb/';
const m = await (await fetch(base + 'data/meta.json')).json();
console.log('builtAt', m.builtAt, 'sources:', JSON.stringify(m.sources || {}).slice(0, 1500));
