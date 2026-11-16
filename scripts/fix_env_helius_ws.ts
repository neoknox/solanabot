import fs from 'fs';
import path from 'path';

const envPath = path.resolve('.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf-8');
  if (content.includes('atlas-mainnet.helius-rpc.com')) {
    const updated = content.replace('atlas-mainnet.helius-rpc.com', 'mainnet.helius-rpc.com');
    fs.writeFileSync(envPath, updated, 'utf-8');
    console.log('Successfully updated .env: replaced atlas-mainnet.helius-rpc.com with mainnet.helius-rpc.com');
  } else {
    console.log('.env already points to standard Helius WS endpoint');
  }
} else {
  console.error('.env not found!');
}
