// Public edition uses independently created neutral artwork; mappings use actual imported experts.
const scenes=[
  ['back-to-school','开学季',['fbsir-beike-yi:fbsir-beike-yi','liuxue-yanxue-expert:liuxue-yanxue-expert']],
  ['content-creation','内容创作',['content-creator:content-creator','ai-humanizer:ai-humanizer','wechat-official-account-expert:wechat-official-account-expert']],
  ['investment-analysis','投资分析',['equity-research:equity-research-expert','aihot:aihot']],
  ['small-business','小微企业',['workspace-builder:workspace-builder','geo-diagnosis-expert:geo-diagnosis-expert']],
  ['ecommerce-operations','电商运营',['douyin-strategist:douyin-strategist','geo-diagnosis-expert:geo-diagnosis-expert']],
  ['professional-docs','专业文档',['ai-humanizer:ai-humanizer','fbsir-beike-yi:fbsir-beike-yi']],
  ['product-design','产品设计',['game-development-studio:game-development-studio-team-lead','remotion-video-generator:remotion-video-expert']],
  ['engineering','工程开发',['senior-developer:senior-developer','workspace-builder:workspace-builder']]
];
const categories={'02-Engineering':'工程开发','03-GameSpatial':'游戏与空间','04-DataAI':'数据与AI','05-MarketingGrowth':'营销与增长','06-ContentCreative':'内容创作','07-SalesCommerce':'销售与商务','09-OperationsHR':'运营与人力','12-IndustryConsultant':'行业咨询'};
const artwork={'back-to-school':'back-to-school','content-creation':'content-creation','investment-analysis':'investment','small-business':'small-business','ecommerce-operations':'ecommerce','professional-docs':'professional-docs','product-design':'product-design','engineering':'engineering'};
export const marketArtworkFiles=new Set(Object.values(artwork).map(id=>`scene-${id}-header.png`));
export function marketPresentation(catalog,store){
  const counts=new Map(store.db.prepare('SELECT s.expert_id AS id,COUNT(DISTINCT s.id) AS uses FROM sessions s JOIN runs r ON r.session_id=s.id WHERE s.expert_id IS NOT NULL GROUP BY s.expert_id').all().map(r=>[r.id,r.uses]));
  const experts=catalog.experts.map(e=>({...e,categoryName:categories[e.categoryName]||e.categoryName,useCount:counts.get(e.id)||0,usageScope:'local-started-sessions',importedAt:e.importedAt||catalog.sources?.find(s=>s.id===e.source)?.capturedAt||null}));
  const available=new Set(experts.map(e=>e.id));
  return {...catalog,experts,featuredScenes:scenes.map(([id,title,ids])=>({id,title,bannerUrl:`/api/market-artwork/scene-${artwork[id]}-header.png`,expertIds:ids.map(x=>'workbuddy:'+x).filter(x=>available.has(x)),mapping:'local-installed-experts'})).filter(s=>s.expertIds.length)};
}
