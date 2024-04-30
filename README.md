# stargate.finance tools

A simple script that gets yield farming data from stargate.finance and calculates the APY for each pool along with the current
user share of the pool with rewards.

## Installation

1. Install Deno from https://deno.land/
2. Clone the repository
3. Set up the environment file
```bash
cp .env.example .env
```
4. Edit the .env file with your CoinGecko API key, or leave it blank to use the default API key.

## Usage
```bash
deno run -A main.ts --help
```

## Example
```bash
deno run -A main.ts --chain mainnet --address 0x0d4a11d5eeaac28ec3f61d100daf4d40471f1852 --verbose
```
