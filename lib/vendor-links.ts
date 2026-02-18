export function getVendorSearchUrl(site: string, query: string): string {
  const q = encodeURIComponent(query);
  switch (site) {
    case "amazon":
    case "amazon_business":
      return `https://www.amazon.com/s?k=${q}`;
    case "bestbuy":
      return `https://www.bestbuy.com/site/searchpage.jsp?st=${q}`;
    case "newegg":
      return `https://www.newegg.com/p/pl?d=${q}`;
    case "bhphotovideo":
      return `https://www.bhphotovideo.com/c/search?q=${q}`;
    case "walmart":
    case "walmart_business":
      return `https://www.walmart.com/search?q=${q}`;
    case "staples":
      return `https://www.staples.com/${q}/directory_${q}`;
    case "officedepot":
      return `https://www.officedepot.com/a/search/?q=${q}`;
    case "quill":
      return `https://www.quill.com/search?keywords=${q}`;
    case "webstaurantstore":
      return `https://www.webstaurantstore.com/search/${q}.html`;
    case "katom":
      return `https://www.katom.com/search.html?query=${q}`;
    case "centralrestaurant":
      return `https://www.centralrestaurant.com/search/${q}`;
    case "therestaurantstore":
      return `https://www.therestaurantstore.com/search/${q}`;
    case "restaurantdepot":
      return `https://www.restaurantdepot.com/catalogsearch/result/?q=${q}`;
    case "grainger":
      return `https://www.grainger.com/search?searchQuery=${q}`;
    case "zoro":
      return `https://www.zoro.com/search?q=${q}`;
    case "homedepot":
      return `https://www.homedepot.com/s/${q}`;
    case "platt":
      return `https://www.platt.com/search.aspx?q=${q}`;
    case "cityelectricsupply":
      return `https://www.cityelectricsupply.com/search?text=${q}`;
    case "uline":
      return `https://www.uline.com/BL_35/Search?keywords=${q}`;
    case "target":
      return `https://www.target.com/s?searchTerm=${q}`;
    case "adorama":
      return `https://www.adorama.com/l/?searchinfo=${q}`;
    case "microcenter":
      return `https://www.microcenter.com/search/search_results.aspx?Ntt=${q}`;
    case "ebay":
      return `https://www.ebay.com/sch/i.html?_nkw=${q}`;
    case "google_shopping":
      return `https://www.google.com/search?tbm=shop&q=${q}`;
    case "ace_mart":
      return `https://www.acemart.com/search?q=${q}`;
    case "lowes":
      return `https://www.lowes.com/search?searchTerm=${q}`;
    case "mcmaster":
      return `https://www.mcmaster.com/products/${q}/`;
    default:
      return `https://www.google.com/search?q=${q}+buy`;
  }
}
