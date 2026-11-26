import { compareStocksTool } from './compare-stocks.js'
import { getFundamentalsTool } from './get-fundamentals.js'
import { getHistoryTool } from './get-history.js'
import { getInstitutionalTool } from './get-institutional.js'
import { getMarginTradingTool } from './get-margin-trading.js'
import { getMarketEventsTool } from './get-market-events.js'
import { getMarketIndexTool } from './get-market-index.js'
import { getMarketMoversTool } from './get-market-movers.js'
import { getMarketOverviewTool } from './get-market-overview.js'
import { getOwnershipTool } from './get-ownership.js'
import { getQuoteTool } from './get-quote.js'
import { getStockOverviewTool } from './get-stock-overview.js'
import { screenStocksTool } from './screen-stocks.js'
import { searchSecurityTool } from './search-security.js'

/** Ordered roughly by how often an agent should reach for them. */
export const tools = [
  searchSecurityTool,
  getStockOverviewTool,
  compareStocksTool,
  getQuoteTool,
  getHistoryTool,
  getFundamentalsTool,
  getOwnershipTool,
  getInstitutionalTool,
  getMarginTradingTool,
  getMarketEventsTool,
  getMarketIndexTool,
  getMarketOverviewTool,
  getMarketMoversTool,
  screenStocksTool,
]
