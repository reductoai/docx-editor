import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

async function main() {
  console.log('Starting template build...');
  try {
    const result = await Template.build(template, 'docx-editor', {
      apiKey: process.env.E2B_ACCESS_TOKEN || process.env.E2B_API_KEY,
      onBuildLogs: defaultBuildLogger(),
    });
    console.log('Template built successfully:', result);
  } catch (err) {
    console.error('Build failed:', err);
    if (err instanceof Error) {
      console.error('Message:', err.message);
      console.error('Stack:', err.stack);
    }
    process.exit(1);
  }
}

main();
