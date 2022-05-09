declare global {
    namespace NodeJS {
      interface ProcessEnv {
        MAILCOW_HOST: string;
        MAILCOW_DOMAIN: string;
        MAILCOW_DESTINATION: string;
        MAILCOW_USER: string;
        MAILCOW_PASSWORD: string;
        MAILCOW_API_KEY: string;

        ACCOUNT_TO_GENERATE: number;
        WORKERS: number;

        MYSQL_HOST: string;
        MYSQL_PORT: number;
        MYSQL_USER: string;
        MYSQL_PASSWORD: string;
        MYSQL_DATABASE: string;
      }
    }
  }export {};