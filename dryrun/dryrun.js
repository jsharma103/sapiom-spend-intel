import { createFetch } from '@sapiom/fetch';

if (!process.env.SAPIOM_API_KEY) {
  console.error('Error: SAPIOM_API_KEY environment variable is not set. Run: export SAPIOM_API_KEY=...');
  process.exit(1);
}

const sapiomFetch = createFetch({
  apiKey: process.env.SAPIOM_API_KEY,
  agentName: 'dryrun-researcher', // IMPORTANT: include agentName so spend is attributed to an agent
});

const response = await sapiomFetch('https://linkup.services.sapiom.ai/v1/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ q: 'Latest developments in AI assistants', depth: 'standard', outputType: 'sourcedAnswer' }),
});

console.log(`HTTP status: ${response.status}`);

const data = await response.json();
console.log(JSON.stringify(data, null, 2).slice(0, 2000));
