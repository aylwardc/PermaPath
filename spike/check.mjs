const q = async (query) => (await (await fetch('https://arweave.net/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})})).json()).data.transactions.edges.map(e=>Object.fromEntries(e.node.tags.map(t=>[t.name,t.value])));
const ups = await q(`{transactions(first:100,tags:[{name:"App-Name",values:["PermaPath-Spike"]},{name:"Type",values:["update"]}]){edges{node{tags{name value}}}}}`);
const byLink = {};
for (const t of ups) (byLink[t.Link] ||= []).push(t.Seq);
console.log(byLink);
