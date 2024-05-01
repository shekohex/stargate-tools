# stargate.finance tools

A simple script that gets yield farming data from stargate.finance and
calculates the APY for each pool along with the current user share of the pool
with rewards.

## Installation

1. Install Deno from https://deno.land/
2. Clone the repository
3. Set up the environment file

```bash
cp .env.example .env
```

4. (Optional) Edit the .env file with your CoinGecko API key, or leave it blank to use the
   default API key.

## Usage

```bash
deno run -A main.ts --help
```

## Example

```bash
deno run -A main.ts --chain mainnet --address 0x93652ae25d0ba757c3c92a4deb0b05dd1d4efe35 --verbose
```
