// Generated from config/schema.yaml by npm run generate:schema.
export interface AafData {
  "entity"?: {
    "legalName"?: string;
    "type"?: string;
    "abn"?: string;
    "email"?: string;
  };
  "address"?: {
    "line1"?: string;
    "suburb"?: string;
    "state"?: string;
    "postcode"?: string;
    "country"?: string;
  };
  "tax"?: {
    "residency"?: string;
    "foreignTax"?: boolean;
    "foreignTin"?: string;
    "declaration"?: string;
  };
  "accounts"?: {
    "productCode"?: string;
    "accountNumber"?: string;
    "bsb"?: string;
    "openDate"?: string;
  }[];
  "people"?: {
    "name"?: string;
    "email"?: string;
    "role"?: string;
  }[];
  "signatories"?: {
    "name"?: string;
    "identityReference"?: string;
    "authorityLimit"?: number;
  }[];
  "products"?: {
    "TRAN"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "SAVE"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "TD"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "FX"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "LOAN"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "OD"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "CARD"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "MERCHANT"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "PAYROLL"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "BPAY"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "DIRECT"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "TRADE"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "GUARANTEE"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "CASH"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "TRUST"?: {
      "instructions"?: string;
      "reference"?: string;
    };
    "ESCROW"?: {
      "instructions"?: string;
      "reference"?: string;
    };
  };
}
