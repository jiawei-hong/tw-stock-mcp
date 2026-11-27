import { classifySecurity, parseSecurityRecords, rankSecurities } from '../src/core/securities.js'
import { tdccRecords } from './fixtures.js'

describe('classifySecurity', () => {
  it.each([
    ['2330', 'stock'],
    ['9103', 'stock'],
    ['0050', 'etf'],
    ['00878', 'etf'],
    ['00631L', 'etf'],
    ['006208', 'etf'],
    ['00400A', 'etf'],
    ['2881A', 'preferred'],
    ['020000', 'etn'],
    ['02001L', 'etn'],
    ['23301', 'convertible_bond'],
    ['030156', 'warrant'],
    ['03011T', 'warrant'],
    ['712345', 'warrant'],
    ['01001T', 'other'],
    ['0337', 'other'],
  ])('classifies %s as %s', (code, type) => {
    expect(classifySecurity(code)).toBe(type)
  })
})

describe('rankSecurities', () => {
  const securities = parseSecurityRecords(tdccRecords)

  it('puts the stock ahead of warrants with the same prefix', () => {
    const all = rankSecurities(securities, '台積', {
      types: ['stock', 'warrant'],
    })
    expect(all.map((security) => security.code)).toEqual(['2330', '030156'])
  })

  it('ranks exact matches first', () => {
    expect(rankSecurities(securities, '2330')[0].code).toBe('2330')
  })
})
