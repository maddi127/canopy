import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ── New flow ──────────────────────────────────────────────────────────────────
import HomePage from './pages/HomePage';
import NewPreferencesPage from './pages/NewPreferencesPage';
import DrawPage from './pages/DrawPage';
import NewDrawPage from './pages/NewDrawPage';
import MarkingsPage from './pages/MarkingsPage';
import AnchorFeaturesPage from './pages/AnchorFeaturesPage';
import WalkwayPage from './pages/WalkwayPage';
import FeaturesPage from './pages/FeaturesPage';
import LayoutPage from './pages/LayoutPage';
import MapLayoutPage from './pages/MapLayoutPage';
import ConceptPage from './pages/ConceptPage';
import PlantingPage from './pages/PlantingPage';
import PlantGenerationPage from './pages/PlantGenerationPage';
import PlantPlanPage from './pages/PlantPlanPage';
import DeliveryStep1Page from './pages/DeliveryStep1Page';
import DeliveryStep2Page from './pages/DeliveryStep2Page';
import DeliveryStep3Page from './pages/DeliveryStep3Page';
import PaymentPage from './pages/PaymentPage';
import ConceptReviewPage from './pages/ConceptReviewPage';
import PlanCreationPage from './pages/PlanCreationPage';
import ConceptGeneratingPage from './pages/ConceptGeneratingPage';
import ConceptChoicePage from './pages/ConceptChoicePage';
import LayoutReviewPage from './pages/LayoutReviewPage';
import PlantPreselectionPage from './pages/PlantPreselectionPage';

// ── DIY flow ──────────────────────────────────────────────────────────────────
import DiyPreferencesPage    from './pages/DiyPreferencesPage';
import DiyConceptPage        from './pages/DiyConceptPage';
import DiyPaymentPage        from './pages/DiyPaymentPage';
import DiyBoundaryPage       from './pages/DiyBoundaryPage';
import DiyFeatureConfirmPage from './pages/DiyFeatureConfirmPage';
import DiyRefinePage         from './pages/DiyRefinePage';
import DiyFinalRenderPage    from './pages/DiyFinalRenderPage';
import DiyPlanPage           from './pages/DiyPlanPage';
import DiyPlanRevealPage     from './pages/DiyPlanRevealPage';
import DiyPlantSelectPage    from './pages/DiyPlantSelectPage';

import ProjectAreaPage from './pages/ProjectAreaPage';
import PhotoCalibrationPage from './pages/PhotoCalibrationPage';

// ── Testing sandbox ───────────────────────────────────────────────────────────
import TestingPage from './pages/TestingPage';
import MapTestingPage from './pages/MapTestingPage';
import AnnotationTestPage from './pages/AnnotationTestPage';
import TreeDetectionPage from './pages/TreeDetectionPage';

// ── Legacy flow (preserved, path-isolated) ────────────────────────────────────
import OnboardingPage from './pages/OnboardingPage';
import SiteSetupPage from './pages/SiteSetupPage';
import ProjectSummaryPage from './pages/ProjectSummaryPage';
import PreferencesGoalsPage from './pages/PreferencesGoalsPage';
import ConceptsGeneratingPage from './pages/ConceptsGeneratingPage';
import ConceptsResultsPage from './pages/ConceptsResultsPage';
import SitePlanPage from './pages/SitePlanPage';
import PlanGenerationPage from './pages/PlanGenerationPage';
import PlantSelectionPage from './pages/PlantSelectionPage';
import DesignPage from './pages/DesignPage';
import MarketplacePage from './pages/MarketplacePage';

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <div className="min-h-screen bg-soil-100">
          <Routes>
            {/* Active flow: address → preferences → concept → site plan → aerial */}
            <Route path="/" element={<HomePage />} />
            <Route path="/preferences"    element={<PreferencesGoalsPage />} />
            <Route path="/site-plan"        element={<SitePlanPage />} />
            <Route path="/payment"             element={<PaymentPage />} />
            <Route path="/project-area"       element={<ProjectAreaPage />} />
            <Route path="/photo-calibration"  element={<PhotoCalibrationPage />} />
            <Route path="/plan-creation"      element={<PlanCreationPage />} />
            <Route path="/concept-review"      element={<ConceptReviewPage />} />
            <Route path="/concept-generating" element={<ConceptGeneratingPage />} />
            <Route path="/concept-choice"     element={<ConceptChoicePage />} />
            <Route path="/generating-plan" element={<PlanGenerationPage />} />
            <Route path="/layout-review"    element={<LayoutReviewPage />} />
            <Route path="/plant-preselection" element={<PlantPreselectionPage />} />
            <Route path="/plant-generation" element={<PlantGenerationPage />} />
            <Route path="/plant-plan"       element={<PlantPlanPage />} />
            <Route path="/delivery/1"       element={<DeliveryStep1Page />} />
            <Route path="/delivery/2"       element={<DeliveryStep2Page />} />
            <Route path="/delivery/3"       element={<DeliveryStep3Page />} />

            {/* New flow (zone layout work) — preserved, accessible directly */}
            <Route path="/new-preferences" element={<NewPreferencesPage />} />
            <Route path="/new-draw"   element={<NewDrawPage />} />
            <Route path="/draw"       element={<DrawPage />} />
            <Route path="/markings"        element={<MarkingsPage />} />
            <Route path="/anchor-features" element={<AnchorFeaturesPage />} />
            <Route path="/map-layout"      element={<MapLayoutPage />} />
            <Route path="/walkway"  element={<WalkwayPage />} />
            <Route path="/features" element={<FeaturesPage />} />
            <Route path="/layout"   element={<LayoutPage />} />
            <Route path="/concept"  element={<ConceptPage />} />
            <Route path="/planting" element={<PlantingPage />} />

            {/* DIY flow */}
            <Route path="/diy/preferences" element={<DiyPreferencesPage />} />
            <Route path="/diy/concept"     element={<DiyConceptPage />} />
            <Route path="/diy/payment"     element={<DiyPaymentPage />} />
            <Route path="/diy/boundary"       element={<DiyBoundaryPage />} />
            <Route path="/diy/plants"         element={<DiyPlantSelectPage />} />
            <Route path="/diy/feature-confirm" element={<DiyFeatureConfirmPage />} />
            <Route path="/diy/plan-reveal" element={<DiyPlanRevealPage />} />
            <Route path="/diy/refine"      element={<DiyRefinePage />} />
            <Route path="/diy/render"      element={<DiyFinalRenderPage />} />
            <Route path="/diy/plan"        element={<DiyPlanPage />} />

            {/* Testing sandbox */}
            <Route path="/testing"         element={<TestingPage />} />
            <Route path="/map-testing"     element={<MapTestingPage />} />
            <Route path="/annotation-test" element={<AnnotationTestPage />} />
            <Route path="/tree-detection"  element={<TreeDetectionPage />} />

            {/* Legacy — preserved */}
            <Route path="/legacy/start"               element={<OnboardingPage />} />
            <Route path="/legacy/site-setup"          element={<SiteSetupPage />} />
            <Route path="/legacy/project-summary"     element={<ProjectSummaryPage />} />
            <Route path="/legacy/concepts/generating" element={<ConceptsGeneratingPage />} />
            <Route path="/legacy/concepts/results"    element={<ConceptsResultsPage />} />
            <Route path="/legacy/plant-selection"     element={<PlantSelectionPage />} />
            <Route path="/legacy/design/:projectId"   element={<DesignPage />} />
            <Route path="/legacy/marketplace"         element={<MarketplacePage />} />
          </Routes>
        </div>
      </Router>
    </QueryClientProvider>
  );
}

export default App;
