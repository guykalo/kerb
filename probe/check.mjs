const j = await (await fetch('https://guykalo.github.io/kerb/data/fines.json')).json();
console.log(j.fineYear, j.councilYear, j.of, (JSON.stringify(j).length / 1024).toFixed(0) + 'KB');
for (const c of j.councils.slice(0, 12)) console.log(c.rank, c.name, c.n, c.km2, c.perKm2, c.level);
console.log('...'); for (const c of j.councils.slice(-5)) console.log(c.rank, c.name, c.n, c.km2, c.perKm2, c.level);
