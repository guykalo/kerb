const K = await (await fetch('https://guykalo.github.io/kerb/data/mel/kerbs.json')).json(), R = await (await fetch('https://guykalo.github.io/kerb/data/mel/rules.json')).json();
for (const f of K.features.filter((f) => /^Toorak Road/.test(f.properties.s)).slice(0, 8)) console.log(JSON.stringify(f.properties), JSON.stringify(R[f.properties.k]));
