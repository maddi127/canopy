import { BrowserRouter as Router, Routes, Route, Outlet } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AuthProvider } from './context/AuthContext';
import RequireAuth from './components/RequireAuth';
import AuthPage from './pages/AuthPage';
import MyProjectsPage from './pages/MyProjectsPage';

import HomePage from './pages/HomePage';
import AddressPage from './pages/AddressPage';
import PreferencesGoalsPage from './pages/PreferencesGoalsPage';
import PaymentPage from './pages/PaymentPage';

// ── Draft-first flow ────────────────────────────────────────────────────────────
import DraftStartPage   from './pages/draft/DraftStartPage';
import DraftScanPage    from './pages/draft/DraftScanPage';
import DraftConfirmPage from './pages/draft/DraftConfirmPage';
import DraftPlanPage    from './pages/draft/DraftPlanPage';
import DraftOutputPage  from './pages/draft/DraftOutputPage';

// ── DIY flow ──────────────────────────────────────────────────────────────────
import DiyPreferencesPage    from './pages/DiyPreferencesPage';
import DiyConceptPage        from './pages/DiyConceptPage';
import DiyPaymentPage        from './pages/DiyPaymentPage';
import DiyBoundaryPage       from './pages/DiyBoundaryPage';
import DiyPlanReadyPage      from './pages/DiyPlanReadyPage';
import DiyFeatureConfirmPage from './pages/DiyFeatureConfirmPage';
import DiyRefinePage         from './pages/DiyRefinePage';
import DiyFinalRenderPage    from './pages/DiyFinalRenderPage';
import DiyPlanPage           from './pages/DiyPlanPage';
import DiyPlanRevealPage     from './pages/DiyPlanRevealPage';
import DiyPlantSelectPage    from './pages/DiyPlantSelectPage';
import DiyLayoutPage         from './pages/DiyLayoutPage';
import DiyPlacementPage      from './pages/DiyPlacementPage';
import DiyReviewPage         from './pages/DiyReviewPage';
import DiyPlantsPage         from './pages/DiyPlantsPage';
import Yard3DPage            from './pages/Yard3DPage';
import DiyAutoLayoutPage     from './pages/DiyAutoLayoutPage';
import DiySiteRevealPage     from './pages/DiySiteRevealPage';

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Router>
          <div className="min-h-screen bg-soil-100">
            <Routes>
              {/* Auth + saved projects */}
              <Route path="/auth"     element={<AuthPage />} />
              <Route path="/projects" element={<RequireAuth><MyProjectsPage /></RequireAuth>} />

              <Route path="/" element={<HomePage />} />
              <Route path="/start" element={<AddressPage />} />

              {/* Draft-first flow: address → scan + quick picks → one-tap boundary confirm →
                  draft plan (simplified edits) → weekend build plan. No auth gate. */}
              <Route path="/draft"         element={<DraftStartPage />} />
              <Route path="/draft/scan"    element={<DraftScanPage />} />
              <Route path="/draft/confirm" element={<DraftConfirmPage />} />
              <Route path="/draft/plan"    element={<DraftPlanPage />} />
              <Route path="/draft/output"  element={<DraftOutputPage />} />
              <Route path="/preferences" element={<PreferencesGoalsPage nextPath="/diy/boundary" skipPhoto journeyTotal={6} />} />
              <Route path="/payment"     element={<PaymentPage />} />

              {/* DIY: preferences + boundary + plan-ready are OPEN; account creation is required
                  when leaving "your draft plan is ready" for the editor (auto-layout onward). */}
              <Route path="/diy/preferences"     element={<DiyPreferencesPage />} />
              <Route path="/diy/boundary"        element={<DiyBoundaryPage />} />
              <Route path="/diy/plan-ready"      element={<DiyPlanReadyPage />} />
              <Route element={<RequireAuth><Outlet /></RequireAuth>}>
                <Route path="/diy/concept"         element={<DiyConceptPage />} />
                <Route path="/diy/payment"         element={<DiyPaymentPage />} />
                <Route path="/diy/plants"          element={<DiyPlantSelectPage />} />
                <Route path="/diy/feature-confirm" element={<DiyFeatureConfirmPage />} />
                <Route path="/diy/plan-reveal"     element={<DiyPlanRevealPage />} />
                <Route path="/diy/refine"          element={<DiyRefinePage />} />
                <Route path="/diy/render"          element={<DiyFinalRenderPage />} />
                <Route path="/diy/layout"          element={<DiyLayoutPage />} />
                <Route path="/diy/placement"       element={<DiyPlacementPage />} />
                <Route path="/diy/auto-layout"     element={<DiyAutoLayoutPage />} />
                <Route path="/diy/site-reveal"     element={<DiySiteRevealPage />} />
                <Route path="/diy/review"          element={<DiyReviewPage />} />
                <Route path="/diy/plant-options"   element={<DiyPlantsPage />} />
                <Route path="/diy/yard-3d"         element={<Yard3DPage />} />
                <Route path="/diy/plan"            element={<DiyPlanPage />} />
              </Route>
            </Routes>
          </div>
        </Router>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
