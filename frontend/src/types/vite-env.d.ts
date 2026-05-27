/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_CARDANO_NETWORK?: 'mainnet' | 'preprod' | 'preview';
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// CIP-30 wallet API surface on window.cardano[walletName]
interface CardanoWalletApi {
  signData: (
    address: string,
    payload: string,
  ) => Promise<{ signature: string; key: string }>;
  getRewardAddresses: () => Promise<string[]>;
  getUsedAddresses: () => Promise<string[]>;
  // CIP-30 §1: 1 = mainnet, 0 = testnet (preprod/preview share id 0)
  getNetworkId: () => Promise<number>;
}

interface CardanoWalletConnector {
  enable: () => Promise<CardanoWalletApi>;
  isEnabled?: () => Promise<boolean>;
  apiVersion?: string;
  name?: string;
  icon?: string;
}

interface Window {
  cardano?: Record<string, CardanoWalletConnector | undefined>;
}
