import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  RH_CHAIN_ID: z.coerce.number().int().positive().default(4663),
  RH_RPC_URL: z.url().default('https://rpc.mainnet.chain.robinhood.com'),
  RH_RPC_FALLBACK_URLS: z.string().optional(),
  WALLET_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'WALLET_ADDRESS must be a valid EVM address')
    .optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid environment variables: ${issues}`);
}

export const env = parsed.data;
