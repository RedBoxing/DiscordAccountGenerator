declare global {
    namespace NodeJS {
      interface ProcessEnv {
        MAILCOW_HOST: string;
        MAILCOW_DOMAIN: string;
        MAILCOW_DESTINATION: string;
        MAILCOW_USER: string;
        MAILCOW_PASSWORD: string;
        MAILCOW_API_KEY: string;

        ACCOUNT_TO_GENERATE: string;
        WORKERS: number
      }
    }
  }export {};